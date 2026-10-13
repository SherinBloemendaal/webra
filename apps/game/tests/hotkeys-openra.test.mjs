// OpenRA's Red Alert hotkeys in WebRA (js/openra-hotkeys.js, js/hotkeys.js,
// js/input.js, js/gamekeys.js, js/commandbar.js, js/chatkeys.js): every
// OpenRA hotkey has an action, the defaults are OpenRA's (except where the
// browser keeps the key), no two actions of one game mode share a key, saved
// bindings of older versions migrate, and the sidebar modes, production slots,
// control groups, cycling, radar pings and chat keys behave like OpenRA's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { OPENRA_HOTKEYS, HOTKEY_GROUPS } from '../js/openra-hotkeys.js';
import {
  BROWSER_SUBSTITUTES,
  HotkeyRegistry,
  KEYMAP_VERSION,
  KEYMAP_VERSION_KEY,
  LEGACY_DEFAULTS,
  migrateOverrides,
  openraDefaults,
  groupOfTypes,
} from '../js/hotkeys.js';
import { createSettings as settingsOver } from '../js/settings.js';
import { createRegistry } from '../js/registry.js';
import { GAME_KEYS, keyContexts, registerGameKeys } from '../js/gamekeys.js';
import { COMMAND_HOTKEYS } from '../js/commandbar.js';
import { CHAT_HOTKEYS, chatMode, completeName, hasTeamChat } from '../js/chatkeys.js';
import { RadarPings, STRUCTURE_INTERVAL_MS, UNIT_INTERVAL_MS, PING_TICKS, FROM_RADIUS, TO_RADIUS } from '../js/radarpings.js';
import { EV, STRIDE } from '../js/audio/director.js';
import { POWER_KINDS } from '../js/audio/catalog.js';
import { History, PANELS, PANEL_ORDER } from '../js/observer.js';

const NONE = 0xffffffff;
const createSettings = (storage = null) => settingsOver(createRegistry({ storage }));

// ---- The generated table ---------------------------------------------------------------

test('the OpenRA table holds every hotkey of the vendored files with its key', () => {
  const dir = new URL('../../../data/source/hotkeys/', import.meta.url);
  const names = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.yaml'))) {
    for (const line of readFileSync(new URL(f, dir), 'utf8').split('\n')) {
      const m = /^([A-Za-z0-9]+):/.exec(line);
      if (m) names.push(m[1]);
    }
  }
  assert.deepEqual(new Set(Object.keys(OPENRA_HOTKEYS)), new Set(names));
  const k = (n) => OPENRA_HOTKEYS[n].key;
  // mods/ra/hotkeys.yaml
  assert.deepEqual(['E', 'R', 'T', 'Y', 'U', 'I', 'X'], ['Building', 'Defense', 'Infantry', 'Vehicle', 'Aircraft', 'Naval'].map((t) => k(`ProductionType${t}`)).concat(k('PowerDown')));
  // game.yaml
  assert.deepEqual(
    ['CycleBase', 'ToLastEvent', 'ToSelection', 'SelectAllUnits', 'SelectUnitsByType', 'CycleHarvesters', 'Pause', 'Sell', 'Repair', 'PlaceBeacon', 'CycleStatusBars', 'ToggleMute', 'TakeScreenshot', 'QuickSave', 'AttackMove'].map(k),
    ['H', 'Space', 'Home', 'Q', 'W', 'N', 'Pause', 'Z', 'C', 'B', ',', 'M', 'Ctrl+P', 'NumpadEnter', 'A'],
  );
  assert.deepEqual(['Scatter', 'Guard', 'Deploy', 'Stop', 'StanceHoldFire'].map(k), ['Ctrl+X', 'D', 'F', 'S', 'Alt+F']);
  // production-common.yaml
  assert.deepEqual([k('CycleProductionBuildings'), k('SelectProductionBuilding'), k('Production01'), k('Production12'), k('Production13'), k('Production24')], ['Ctrl+Tab', 'Tab', 'F1', 'F12', 'Ctrl+F1', 'Ctrl+F12']);
  // viewport.yaml, control-groups.yaml, chat.yaml, observer.yaml
  assert.deepEqual([k('MapBookmarkSave01'), k('MapBookmarkRestore04'), k('DisableAllUserInterface'), k('MapScrollUp')], ['Ctrl+Q', 'Alt+R', 'Alt+Shift+=', 'ArrowUp']);
  assert.deepEqual([k('ControlGroupSelect10'), k('ControlGroupCreate01'), k('ControlGroupAddTo01'), k('ControlGroupCombineWith01'), k('ControlGroupJumpTo01')], ['0', 'Ctrl+1', 'Ctrl+Shift+1', 'Shift+1', 'Alt+1']);
  assert.deepEqual([k('OpenTeamChat'), k('OpenGeneralChat'), k('ToggleChatMode'), k('Autocomplete')], ['Enter', 'Shift+Enter', 'Shift+Tab', 'Tab']);
  assert.equal(OPENRA_HOTKEYS.Autocomplete.readonly, true);
  assert.deepEqual([k('ObserverCombinedView'), k('StatisticsArmy'), k('ReplaySpeedSlow'), k('StopMusic')], ['-', 'F7', 'F9', 'MediaStop']);
  assert.equal(k('SupportPower01'), null, 'OpenRA has no default support power keys');
  assert.equal(OPENRA_HOTKEYS.CycleBase.description, 'Jump to base');
  assert.deepEqual(HOTKEY_GROUPS.map((g) => g.label).slice(0, 3), ['Game Commands', 'Viewport Commands', 'Observer / Replay Commands']);
  assert.equal(groupOfTypes(['ProductionSlot']), 'Production Commands');
});

// ---- Registering every action, as a player and as a spectator --------------------------

/** Minimal DOM for js/input.js. */
function installDom() {
  globalThis.window ??= { addEventListener() {} };
  globalThis.document ??= { createElement: () => ({}) };
}

/** A fake engine for js/input.js with the queries the hotkeys and modes use. */
function fakeGame(over = {}) {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args.map((v) => (ArrayBuffer.isView(v) ? Array.from(v) : v))]);
  let selection = [];
  return {
    calls,
    map_width: () => 64,
    map_height: () => 64,
    pick: () => NONE,
    select_at: () => NONE,
    actor_json: (id) => JSON.stringify({ id, type: 'e1', owner: 0, building: false, carrier: NONE }),
    set_selection: (ids) => (selection = Array.from(ids)),
    selection: () => Uint32Array.from(selection),
    player_count: () => 2,
    select_box: () => new Uint32Array(0),
    select_all: () => new Uint32Array(0),
    select_by_class: () => new Uint32Array(0),
    units_center: (_p, ids) => (ids.length ? Float32Array.from([ids[0] * 10, ids[0] * 20]) : new Float32Array(0)),
    sell_value: () => 0,
    repair_cursor: () => 0,
    repair_unit_target: () => new Float32Array(0),
    can_power_down: () => false,
    base_actors: () => new Uint32Array(0),
    harvesters: () => new Uint32Array(0),
    production_buildings: () => new Uint32Array(0),
    queue_producer: () => NONE,
    sell: rec('sell'),
    repair_building: rec('repair_building'),
    power_down: rec('power_down'),
    place_beacon: rec('place_beacon'),
    order_smart: rec('order_smart'),
    order_stop: rec('order_stop'),
    set_control_groups: rec('set_control_groups'),
    ...over,
  };
}

async function makeInput({ spectator = false, game = fakeGame(), hooks = {} } = {}) {
  installDom();
  const { Input } = await import('../js/input.js');
  const canvas = { clientWidth: 800, clientHeight: 600, style: {}, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const hotkeys = new HotkeyRegistry(createSettings());
  const allHooks = { onSelectionChanged() {}, onPlaced() {}, onCancelPlace() {}, onPowerTargeting() {}, ...hooks };
  const input = new Input(canvas, game, { actors: [] }, 0, allHooks, { hotkeys, settings: createSettings(), spectator });
  input.camera.zoom = 1;
  return { input, hotkeys, game };
}

/** Every action of one game mode in one registry: input, command bar, game keys, online chat. */
async function everything(spectator) {
  const { hotkeys, input } = await makeInput({ spectator });
  if (!spectator) for (const h of COMMAND_HOTKEYS) hotkeys.registerAction(h.name, h.keys, () => {}, { openra: h.openra, label: h.label, group: h.group });
  const handlers = new Proxy({}, { get: () => () => {} });
  registerGameKeys(hotkeys, handlers, { spectator });
  for (const h of CHAT_HOTKEYS) hotkeys.registerAction(h.name, undefined, () => {}, { openra: h.openra, inControls: false, listOnly: h.listOnly });
  return { hotkeys, input };
}

test('every OpenRA hotkey has a WebRA action, as a player or as a spectator', async () => {
  const player = (await everything(false)).hotkeys.list();
  const spectator = (await everything(true)).hotkeys.list();
  const covered = new Set([...player, ...spectator].map((a) => a.openra).filter(Boolean));
  const missing = Object.keys(OPENRA_HOTKEYS).filter((n) => !covered.has(n));
  assert.deepEqual(missing, []);
  // Spectators get OpenRA's spectator hotkeys only: no orders, production or
  // control groups (the chat line's own keys work for both).
  const inChat = (a) => OPENRA_HOTKEYS[a.openra]?.contexts.includes('chat-input');
  for (const a of spectator) {
    if (a.openra && !inChat(a)) assert.ok(OPENRA_HOTKEYS[a.openra].contexts.includes('spectator'), `${a.name} is not a spectator hotkey`);
  }
  for (const a of player) {
    if (a.openra && !inChat(a)) assert.ok(OPENRA_HOTKEYS[a.openra].contexts.includes('player'), `${a.name} is not a player hotkey`);
  }
});

test("the defaults are OpenRA's, except where the browser keeps the key, and nothing conflicts", async () => {
  for (const spectator of [false, true]) {
    const { hotkeys } = await everything(spectator);
    const taken = new Map();
    for (const a of hotkeys.list()) {
      if (a.openra) {
        const ora = OPENRA_HOTKEYS[a.openra].key;
        const expected = BROWSER_SUBSTITUTES[a.openra] ? BROWSER_SUBSTITUTES[a.openra].key : ora;
        assert.deepEqual(a.defaults, expected ? [expected] : [], `${a.name} (${a.openra})`);
        assert.equal(a.label, OPENRA_HOTKEYS[a.openra].description);
        assert.equal(a.group, groupOfTypes(OPENRA_HOTKEYS[a.openra].types));
      }
      // No default key is lost to another action of the same mode (the chat
      // line's keys are its own, so they do not count).
      assert.deepEqual(a.keys, a.defaults, `${a.name}: ${a.defaults} -> ${a.keys}`);
      if (a.readonly && OPENRA_HOTKEYS[a.openra]?.contexts.includes('chat-input')) continue;
      for (const k of a.keys) {
        assert.ok(!taken.has(k), `${k}: ${taken.get(k)} and ${a.name}`);
        taken.set(k, a.name);
      }
    }
  }
  // The substitutes are only for keys the browser keeps.
  assert.deepEqual(openraDefaults('CycleProductionBuildings'), ['Shift+Tab']);
  assert.deepEqual(openraDefaults('MapBookmarkSave01'), ['Alt+Shift+Q']);
  assert.deepEqual(openraDefaults('MapBookmarkSave03'), ['Ctrl+E'], "OpenRA's own key where the browser allows it");
  assert.deepEqual(openraDefaults('Production11'), []);
  assert.deepEqual(openraDefaults('Production05'), ['F5']);
});

test('the Controls page sections follow OpenRA, and contexts come from OpenRA', async () => {
  const { hotkeys } = await everything(false);
  const byName = new Map(hotkeys.list().map((a) => [a.name, a]));
  assert.equal(byName.get('powerDown').group, 'Game Commands');
  assert.equal(byName.get('production13').group, 'Production Commands');
  assert.equal(byName.get('controlGroupJumpTo03').group, 'Control Groups');
  assert.equal(byName.get('stanceDefend').group, 'Unit Stance Commands');
  assert.equal(byName.get('autocomplete').context, 'chat-input');
  assert.equal(byName.get('autocomplete').readonly, true);
  assert.equal(byName.get('debugMenu').group, 'Game Commands');
  for (const e of GAME_KEYS) assert.ok(keyContexts(e).length > 0, e.name);
});

// ---- Conflicts and rebinding -----------------------------------------------------------

test('a user binding wins over defaults; fixed keys and browser keys cannot be taken', async () => {
  const { hotkeys } = await everything(false);
  // B for buildings, W for weapons, S for sell: the player's own choice.
  assert.deepEqual(hotkeys.rebind('productionTabBuildings', 'B'), { ok: true, displaced: 'placeBeacon' });
  assert.deepEqual(hotkeys.bindingsFor('placeBeacon'), []);
  assert.deepEqual(hotkeys.rebind('sell', 'S'), { ok: true, displaced: 'stop' });
  assert.equal(hotkeys.actionFor('S'), 'sell');
  assert.equal(hotkeys.actionFor('Z'), null);
  assert.equal(hotkeys.rebind('autocomplete', 'Q').ok, false, 'chat line keys are fixed');
  assert.equal(hotkeys.rebind('scatter', 'Ctrl+Tab').ok, false, 'the browser keeps Ctrl+Tab');
  // The chat line's Tab is never dispatched: Tab stays the production facility key.
  assert.equal(hotkeys.actionFor('Tab'), 'selectProductionBuilding');
});

test('production slots take Shift (build 5); the numpad slots take Shift and Ctrl', async () => {
  const reg = new HotkeyRegistry(createSettings());
  const log = [];
  registerGameKeys(reg, { productionSlot: (n, e) => log.push(['slot', n, !!e?.shiftKey]), numpadSlot: (n, e) => log.push(['numpad', n, !!e?.shiftKey, !!e?.ctrlKey]) });
  const ev = (code, key, mods = {}) => ({ code, key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: { tagName: 'BODY' }, preventDefault() {}, ...mods });
  reg.handle(ev('F3', 'F3'));
  reg.handle(ev('F3', 'F3', { shiftKey: true }));
  reg.handle(ev('F1', 'F1', { ctrlKey: true }));
  reg.handle(ev('F2', 'F2', { ctrlKey: true, shiftKey: true }));
  reg.handle(ev('Numpad4', '4', { ctrlKey: true }));
  reg.handle(ev('Numpad4', '4', { shiftKey: true }));
  assert.equal(reg.handle(ev('F3', 'F3', { altKey: true })), false, 'Alt is no batch modifier');
  assert.deepEqual(log, [
    ['slot', 3, false],
    ['slot', 3, true],
    ['slot', 13, false],
    ['slot', 14, true],
    ['numpad', 4, false, true],
    ['numpad', 4, true, false],
  ]);
});

test('slot hotkeys build the n-th item of the active tab, like a click', async () => {
  const { Sidebar } = await import('../js/sidebar.js');
  const started = [];
  const placed = [];
  const card = (id, queue, extra = {}) => [id, { id, actor: { id, queue }, enabled: true, ready: false, queued: 0, ...extra }];
  const fake = {
    playerId: 0,
    visibleIds: ['E1', 'E3', 'DOG'],
    cards: new Map([card('E1', 2), card('E3', 2), card('DOG', 2, { enabled: false })]),
    game: { start_production: (p, id, n) => started.push([id, n]) },
    callbacks: { onPlace: (id) => placed.push(id), shiftLatched: () => false },
    onCardClick: Sidebar.prototype.onCardClick,
  };
  const reg = new HotkeyRegistry(createSettings());
  registerGameKeys(reg, { productionSlot: (n, e) => Sidebar.prototype.activateSlot.call(fake, n, { shift: !!e?.shiftKey }) });
  const ev = (code, mods = {}) => ({ code, key: code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: { tagName: 'BODY' }, preventDefault() {}, ...mods });
  reg.handle(ev('F2'));
  reg.handle(ev('F1', { shiftKey: true }));
  reg.handle(ev('F3'));
  reg.handle(ev('F9'));
  assert.deepEqual(started, [
    ['E3', 1],
    ['E1', 5],
  ], 'F3 is a locked item, F9 an empty slot');
  // A finished structure is placed instead (OpenRA's palette).
  fake.visibleIds = ['POWR'];
  fake.cards = new Map([card('POWR', 0, { ready: true })]);
  reg.handle(ev('F1'));
  assert.deepEqual(placed, ['POWR']);
});

// ---- Saved bindings of older versions ---------------------------------------------------

test('old saved bindings: unchanged defaults and rebinding leftovers go, choices stay', () => {
  // Version 0.7: the player put Guard on X, which left Scatter (old default X) without a key.
  const old = { guard: ['X'], scatter: [], base: ['H', 'Space'], stop: ['Ctrl+S'], deploy: [], bookmarkJump1: ['F1'] };
  const m = migrateOverrides(old);
  assert.deepEqual(m.guard, ['X'], "the player's choice");
  assert.equal('scatter' in m, false, 'emptied by rebinding Guard: back to the new default (Ctrl+X)');
  assert.equal('base' in m, false, 'the old defaults (H, Space): the new default applies');
  assert.deepEqual(m.stop, ['Ctrl+S']);
  assert.deepEqual(m.deploy, [], 'cleared by the player (its keys F and D went nowhere)');
  assert.equal('bookmarkJump1' in m, false, 'F1 was the old default: bookmarks move to Alt+Q');
  // Saved by this version: untouched, even when it looks like an old default.
  const cur = { scatter: ['X'], [KEYMAP_VERSION_KEY]: [KEYMAP_VERSION] };
  assert.deepEqual(migrateOverrides(cur), cur);
  assert.equal(LEGACY_DEFAULTS.menu[0], 'F10');
});

test('the registry applies the migration and saves with the version', async () => {
  const settings = createSettings();
  settings.set('hotkeys', { guard: ['X'], scatter: [], nextTab: ['Tab'] });
  const reg = new HotkeyRegistry(settings);
  for (const h of COMMAND_HOTKEYS) reg.registerAction(h.name, h.keys, () => {}, { openra: h.openra });
  registerGameKeys(reg, { cycleTab: () => {}, selectProductionBuilding: () => {} });
  assert.equal(reg.actionFor('X'), 'guard');
  assert.equal(reg.actionFor('Ctrl+X'), 'scatter', 'Scatter gets OpenRA Ctrl+X back');
  assert.equal(reg.actionFor('D'), null, 'Guard keeps its own key, not D');
  assert.equal(reg.actionFor('Tab'), 'selectProductionBuilding', 'the old Tab default of nextTab is gone');
  assert.equal(reg.rebind('stanceCycle', 'K').ok, true);
  const saved = settings.get('hotkeys');
  assert.deepEqual(saved[KEYMAP_VERSION_KEY], [KEYMAP_VERSION]);
  assert.equal('scatter' in saved, false, 'the leftover is not written back');
  assert.equal('nextTab' in saved, false);
  assert.deepEqual(saved.guard, ['X']);
  assert.deepEqual(saved.stanceCycle, ['K']);
});

// ---- Sidebar modes (js/input.js) ---------------------------------------------------------

test('repair, power down and sell modes stay on; a beacon ends its mode', async () => {
  const modes = [];
  const game = fakeGame({
    pick: (_p, x) => (x < 100 ? 7 : x < 200 ? 8 : NONE),
    repair_cursor: (_p, id) => (id === 7 ? 1 : id === 8 ? 2 : 0),
    repair_unit_target: () => Float32Array.from([300, 400]),
    can_power_down: (_p, id) => id === 7,
    sell_value: (_p, id) => (id === 7 ? 150 : 0),
  });
  const { input, hotkeys } = await makeInput({ game, hooks: { onMode: (m) => modes.push(m) } });
  const key = (code, k = code.replace('Key', '')) => hotkeys.handle({ code, key: k.toLowerCase(), ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: { tagName: 'BODY' }, preventDefault() {} });
  key('KeyC');
  assert.equal(input.mode, 'repair');
  await input.modeClick({ x: 50, y: 50 });
  await input.modeClick({ x: 150, y: 50 });
  assert.equal(input.mode, 'repair', 'stays on');
  key('KeyX');
  assert.equal(input.mode, 'powerDown', 'another mode replaces it');
  await input.modeClick({ x: 50, y: 50 });
  await input.modeClick({ x: 150, y: 50 });
  key('KeyZ');
  await input.modeClick({ x: 50, y: 50 });
  await input.modeClick({ x: 150, y: 50 });
  assert.equal(input.mode, 'sell');
  key('KeyZ');
  assert.equal(input.mode, null, 'the key again ends it');
  key('KeyB');
  await input.modeClick({ x: 240, y: 360 });
  assert.equal(input.mode, null, 'one beacon');
  assert.deepEqual(game.calls, [
    ['repair_building', 0, 7],
    ['order_smart', 0, [8], 300, 400],
    ['power_down', 0, 7],
    ['sell', 0, 7],
    ['place_beacon', 0, 240, 360],
  ]);
  assert.deepEqual(modes, ['repair', 'powerDown', 'sell', null, 'beacon', null]);
  // Esc (cancelMode) and right click end a mode too.
  input.setMode('repair');
  assert.equal(input.cancelMode(), true);
  assert.equal(input.mode, null);
  assert.equal(input.modeTarget({ x: 50, y: 50 }), false, 'no mode');
  input.setMode('repair');
  assert.equal(input.modeTarget({ x: 50, y: 50 }), true);
  assert.equal(input.modeTarget({ x: 500, y: 50 }), false);
});

// ---- Bulk repair and sell (WebRA additions, js/input.js) ----------------------------------

/**
 * Ids 1..3: own structures (3 undamaged), 4: an own damaged tank, 5: an
 * ally's structure, 6: an own damaged ore truck, 7: an own damaged tank with
 * no depot, 8: an own undamaged tank, 9: the own Construction Yard.
 */
function bulkGame(over = {}) {
  const actors = {
    1: { owner: 0, building: true },
    2: { owner: 0, building: true },
    3: { owner: 0, building: true },
    4: { owner: 0, building: false, kind: 'combat' },
    5: { owner: 1, building: true },
    6: { owner: 0, building: false, kind: 'harvesters' },
    7: { owner: 0, building: false, kind: 'combat' },
    8: { owner: 0, building: false },
    9: { owner: 0, building: true },
  };
  const damaged = new Set([1, 2, 4, 6, 7]);
  // The engine's answer: own damaged actors among the ids by category, in their order.
  const groups = (p, ids) => {
    const out = { buildings: [], combat: [], harvesters: [], other: [], noFacility: [] };
    for (const id of new Set(ids)) {
      const a = actors[id];
      if (!a || a.owner !== p || !damaged.has(id)) continue;
      out[a.building ? 'buildings' : a.kind].push(id);
      if (id === 7) out.noFacility.push(id);
    }
    return JSON.stringify(out);
  };
  const recorder = () => {
    const calls = [];
    const f = (...args) => calls.push(args.map((v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)));
    f.calls = calls;
    return f;
  };
  return fakeGame({
    actor_json: (id) => (actors[id] ? JSON.stringify({ id, type: 'x', ...actors[id], carrier: NONE }) : 'null'),
    repair_selection_json: (p, ids) => groups(p, Array.from(ids)),
    // Everything stands inside x < 400; nothing elsewhere.
    repair_box_json: (p, x0, _y0, x1) => groups(p, Math.min(x0, x1) < 400 ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : []),
    // The sell box: 1, 2 and 3 (never the Construction Yard 9), worth 100, 200 and 300.
    sell_box: (_p, x0, _y0, x1) => (Math.min(x0, x1) < 400 ? Uint32Array.from([1, 2, 3]) : Math.min(x0, x1) < 600 ? Uint32Array.from([2]) : new Uint32Array(0)),
    sell_value: (_p, id) => id * 100,
    repair_buildings: recorder(),
    repair_units: recorder(),
    sell_buildings: recorder(),
    ...over,
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const keyEvent = (code, k) => ({ code, key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: { tagName: 'BODY' }, preventDefault() {} });
const mouseOf = (input) => (type, x, y, shift = false) =>
  input[type]({ button: 0, clientX: x, clientY: y, shiftKey: shift, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });

test('the Repair key with own actors selected repairs the damaged ones at once instead of opening the mode', async () => {
  const modes = [];
  const feedback = [];
  const game = bulkGame();
  const { input, hotkeys } = await makeInput({ game, hooks: { onMode: (m) => modes.push(m), feedback: (t) => feedback.push(t) } });
  input.setSelection([4, 3, 2, 5, 1, 6, 7, 8]);
  hotkeys.handle(keyEvent('KeyC', 'c'));
  await flush();
  assert.equal(input.mode, null, 'no repair mode');
  assert.deepEqual(game.repair_buildings.calls, [[0, [2, 1]]], 'one order for the selected own damaged structures');
  assert.deepEqual(game.repair_units.calls, [[0, [4, 6]]], 'one order for the units that have a depot, no chooser');
  assert.deepEqual(feedback, ['No repair facility for one unit.']);
  // The sidebar button goes the same way (main.js: onMode -> toggleMode).
  input.toggleMode('repair');
  await flush();
  assert.equal(game.repair_buildings.calls.length, 2, 'pressed again: the engine stops the structures when all repair');
  // Only undamaged or allied actors selected, or none: repair mode as before.
  for (const sel of [[3], [5], [8], []]) {
    input.setSelection(sel);
    input.toggleMode('repair');
    await flush();
    assert.equal(input.mode, 'repair', `selection ${sel}`);
    input.toggleMode('repair');
    assert.equal(input.mode, null, 'the key again ends the mode');
  }
  assert.equal(game.repair_buildings.calls.length, 2);
  assert.deepEqual(modes, ['repair', null, 'repair', null, 'repair', null, 'repair', null]);
});

test('the Repair key from sell or power down mode leaves that mode before it repairs', async () => {
  const game = bulkGame({ pick: () => 1, sell_value: () => 150 });
  const { input } = await makeInput({ game });
  for (const mode of ['sell', 'powerDown']) {
    input.setMode(mode);
    input.setSelection([1]);
    input.toggleMode('repair');
    assert.equal(input.mode, null, `${mode} ends at once, before the answer`);
    // A click meanwhile sells or powers down nothing.
    await input.modeClick({ x: 50, y: 50 });
    await flush();
    assert.equal(input.mode, null);
  }
  assert.deepEqual(game.calls.filter((c) => c[0] === 'sell' || c[0] === 'power_down'), []);
  assert.equal(game.repair_buildings.calls.length, 2);
});

test('a box dragged in repair mode asks what to repair, remembers it, and Shift skips the question', async () => {
  const asked = [];
  let answer = 'combat';
  const feedback = [];
  const game = bulkGame({ pick: (_p, x) => (x < 100 ? 1 : NONE), repair_cursor: (_p, id) => (id === 1 ? 1 : 0) });
  const settings = createSettings();
  installDom();
  const { Input } = await import('../js/input.js');
  const canvas = { clientWidth: 800, clientHeight: 600, style: {}, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const hooks = {
    onSelectionChanged() {},
    feedback: (t) => feedback.push(t),
    chooseRepair: async (q) => {
      asked.push(q);
      return answer;
    },
  };
  const input = new Input(canvas, game, { actors: [] }, 0, hooks, { hotkeys: new HotkeyRegistry(createSettings()), settings });
  input.camera.zoom = 1;
  const mouse = mouseOf(input);
  input.setMode('repair');
  // While dragging: the yellow box and the repair cursor while it holds something.
  mouse('onMouseDown', 10, 10);
  assert.equal(input.drag, null, 'no selection box');
  mouse('onMouseMove', 300, 200);
  assert.equal(input.modeTarget({ x: 600, y: 600 }), true, 'the box holds things to repair');
  const rects = input.uiRects();
  assert.deepEqual(rects.slice(4, 7), [0.95, 0.79, 0.3], 'in the repair yellow');
  mouse('onMouseUp', 300, 200);
  await flush();
  assert.deepEqual(asked, [{ options: ['buildings', 'combat', 'harvesters', 'all'], last: 'all', at: { x: 300, y: 200 } }]);
  assert.deepEqual(game.repair_units.calls, [[0, [4]]], 'combat units with a depot');
  assert.deepEqual(game.repair_buildings.calls, []);
  assert.deepEqual(feedback, ['No repair facility for one unit.']);
  assert.equal(settings.get('repairBoxChoice'), 'combat', 'remembered');
  // Shift: the last choice without asking.
  mouse('onMouseDown', 10, 10, true);
  mouse('onMouseMove', 300, 200, true);
  mouse('onMouseUp', 300, 200, true);
  await flush();
  assert.equal(asked.length, 1);
  assert.equal(game.repair_units.calls.length, 2);
  // All: structures toggle, units go; cancelled (null): nothing.
  answer = 'all';
  mouse('onMouseDown', 10, 10);
  mouse('onMouseMove', 300, 200);
  mouse('onMouseUp', 300, 200);
  await flush();
  assert.deepEqual(game.repair_buildings.calls, [[0, [1, 2]]]);
  assert.deepEqual(game.repair_units.calls.at(-1), [0, [4, 6]]);
  assert.equal(asked.at(-1).last, 'combat', 'the remembered choice is offered first');
  answer = null;
  mouse('onMouseDown', 10, 10);
  mouse('onMouseMove', 300, 200);
  mouse('onMouseUp', 300, 200);
  await flush();
  assert.equal(game.repair_buildings.calls.length, 1);
  assert.equal(settings.get('repairBoxChoice'), 'all');
  // A box with nothing to repair: the blocked cursor, no question, no order.
  mouse('onMouseDown', 500, 10);
  mouse('onMouseMove', 700, 200);
  assert.equal(input.modeTarget({ x: 50, y: 50 }), false, 'the box decides, not the actor under the mouse');
  mouse('onMouseUp', 700, 200);
  await flush();
  assert.equal(asked.length, 3);
  // A click (less than 6 px of movement) repairs the one structure under it.
  mouse('onMouseDown', 50, 50);
  mouse('onMouseMove', 52, 51);
  mouse('onMouseUp', 52, 51);
  await flush();
  assert.deepEqual(game.calls.filter((c) => c[0] === 'repair_building'), [['repair_building', 0, 1]]);
  // Right click (or Esc) during a drag ends the mode and the box.
  mouse('onMouseDown', 10, 10);
  mouse('onMouseMove', 300, 200);
  input.setMode(null);
  assert.equal(input.modeDrag, null);
  mouse('onMouseUp', 300, 200);
  await flush();
  assert.equal(asked.length, 3);
});

test('a box dragged in sell mode sells the structures in it after a confirmation with the refund', async () => {
  const asked = [];
  let ok = false;
  const game = bulkGame({ pick: (_p, x) => (x < 100 ? 9 : NONE), sell_value: (_p, id) => id * 100 });
  const { input } = await makeInput({ game, hooks: { confirmSell: async (q) => (asked.push(q), ok) } });
  const mouse = mouseOf(input);
  input.setMode('sell');
  mouse('onMouseDown', 10, 10);
  mouse('onMouseMove', 300, 200);
  assert.equal(input.modeTarget({ x: 700, y: 700 }), true, 'the sell cursor while the box holds a structure');
  assert.deepEqual(input.uiRects().slice(4, 7), [0.95, 0.3, 0.22], 'in red');
  mouse('onMouseUp', 300, 200);
  await flush();
  await flush();
  assert.deepEqual(asked, [{ count: 3, refund: 600, at: { x: 300, y: 200 } }], 'the count and the total refund');
  assert.deepEqual(game.sell_buildings.calls, [], 'cancelled: nothing sold');
  ok = true;
  mouse('onMouseDown', 10, 10);
  mouse('onMouseMove', 300, 200);
  mouse('onMouseUp', 300, 200);
  await flush();
  await flush();
  assert.deepEqual(game.sell_buildings.calls, [[0, [1, 2, 3]]]);
  // One structure: no question.
  mouse('onMouseDown', 450, 10);
  mouse('onMouseMove', 500, 200);
  mouse('onMouseUp', 500, 200);
  await flush();
  assert.equal(asked.length, 2);
  assert.deepEqual(game.sell_buildings.calls.at(-1), [0, [2]]);
  // Nothing sellable in the box: the blocked cursor, nothing sold.
  mouse('onMouseDown', 700, 10);
  mouse('onMouseMove', 760, 200);
  assert.equal(input.modeTarget({ x: 50, y: 50 }), false);
  mouse('onMouseUp', 760, 200);
  await flush();
  assert.equal(game.sell_buildings.calls.length, 2);
  // A single click still sells the Construction Yard (9).
  mouse('onMouseDown', 50, 50);
  mouse('onMouseUp', 50, 50);
  await flush();
  assert.deepEqual(game.calls.filter((c) => c[0] === 'sell'), [['sell', 0, 9]]);
  assert.equal(input.mode, 'sell', 'the mode stays on');
});

test('the box chooser: keys, Enter, Esc and a press outside answer it', async () => {
  const { BoxChooser, sellConfirmText, formatCredits } = await import('../js/boxchooser.js');
  assert.equal(formatCredits(12345), '$12,345');
  assert.equal(sellConfirmText(3, 1500), 'Sell 3 structures for $1,500?');
  const listeners = new Map();
  const win = {
    addEventListener: (t, f) => listeners.set(t, f),
    removeEventListener: (t, f) => listeners.get(t) === f && listeners.delete(t),
  };
  const make = (tag) => {
    const el = {
      tag,
      children: [],
      attrs: {},
      style: {},
      handlers: {},
      textContent: '',
      setAttribute: (k, v) => (el.attrs[k] = v),
      append: (...c) => el.children.push(...c),
      addEventListener: (t, f) => (el.handlers[t] = f),
      remove: () => (el.removed = true),
      contains: (x) => x === el || el.children.some((c) => c === x || c.contains?.(x)),
      focus: () => (focused = el),
    };
    return el;
  };
  let focused = null;
  const parent = make('main');
  const doc = { createElement: make };
  const chooser = new BoxChooser(parent, { doc, win });
  const key = (k) => listeners.get('keydown')({ key: k, stopImmediatePropagation() {}, preventDefault() {} });
  let p = chooser.chooseRepair({ options: ['buildings', 'combat', 'all'], last: 'combat', at: { x: 5, y: 5 } });
  const buttons = parent.children[0].children[1].children;
  assert.equal(buttons.length, 3);
  assert.equal(focused, buttons[1], 'the remembered choice has the focus (Enter takes it)');
  key('2');
  assert.equal(await p, 'combat');
  assert.equal(chooser.open, false);
  assert.equal(listeners.size, 0, 'listeners removed');
  p = chooser.chooseRepair({ options: ['buildings', 'harvesters', 'all'], last: 'other', at: null });
  assert.equal(focused, parent.children[1].children[1].children[2], 'All when the last choice is not offered');
  key('o');
  assert.equal(await p, 'harvesters', 'letters pick too');
  p = chooser.chooseRepair({ options: ['buildings', 'all'], last: 'all' });
  key('Escape');
  assert.equal(await p, null);
  p = chooser.confirmSell({ count: 2, refund: 300 });
  listeners.get('pointerdown')({ target: parent });
  assert.equal(await p, false, 'a press outside cancels');
  p = chooser.confirmSell({ count: 2, refund: 300 });
  parent.children.at(-1).children[1].children[0].handlers.click();
  assert.equal(await p, true, 'Sell clicked');
  p = chooser.confirmSell({ count: 2, refund: 300 });
  chooser.cancel();
  assert.equal(await p, false, 'the mode ended');
});

// ---- Selection and camera hotkeys ---------------------------------------------------------

test('cycling bases, harvesters and facilities selects the next one and centres on it', async () => {
  const game = fakeGame({
    base_actors: () => Uint32Array.from([5, 6]),
    harvesters: () => Uint32Array.from([11, 12, 13]),
    production_buildings: () => Uint32Array.from([20]),
    queue_producer: (_p, q) => (q === 3 ? 21 : NONE),
  });
  const { input } = await makeInput({ game });
  await input.cycleBase();
  assert.deepEqual(input.selection, [5]);
  await input.cycleBase();
  assert.deepEqual(input.selection, [6]);
  await input.cycleBase();
  assert.deepEqual(input.selection, [5], 'wraps around');
  await input.cycleHarvesters();
  assert.deepEqual(input.selection, [11]);
  await input.cycleHarvesters();
  assert.deepEqual(input.selection, [12]);
  await input.cycleProductionBuildings();
  assert.deepEqual(input.selection, [20]);
  await input.selectProductionBuilding(3);
  assert.deepEqual(input.selection, [21], 'Tab: the facility of the tab');
  const cam = { ...input.camera };
  await input.selectProductionBuilding(3);
  assert.notDeepEqual(input.camera, cam, 'Tab again: the camera goes to it');
  await input.selectProductionBuilding(0);
  assert.deepEqual(input.selection, [21], 'no producer: nothing happens');
});

test('spectators watching the whole map have no player to cycle through', async () => {
  const game = fakeGame({ base_actors: () => Uint32Array.from([5]) });
  const { input } = await makeInput({ game, spectator: true });
  input.watchAll = true;
  await input.cycleBase();
  assert.deepEqual(input.selection, []);
  input.watchAll = false;
  await input.cycleBase();
  assert.deepEqual(input.selection, [5]);
});

test('select all: on screen, then the whole map when nothing new is selected', async () => {
  const boxes = [];
  const game = fakeGame({
    select_all: (_owners, x0, y0, x1) => {
      boxes.push(x1 > 1000 ? 'map' : 'screen');
      return x1 > 1000 ? Uint32Array.from([1, 2, 3]) : Uint32Array.from([1, 2]);
    },
  });
  const feedback = [];
  const { input } = await makeInput({ game, hooks: { feedback: (t) => feedback.push(t) } });
  await input.selectAllUnits();
  assert.deepEqual(input.selection, [1, 2]);
  await input.selectAllUnits();
  assert.deepEqual(input.selection, [1, 2, 3], 'the same two again: the map');
  assert.deepEqual(boxes, ['screen', 'screen', 'map']);
  assert.deepEqual(feedback, ['Selected 2 units across screen.', 'Selected 3 units across map.']);
});

test('control groups through the hotkeys: create, select, add to, combine, jump, remove', async () => {
  const game = fakeGame({ actor_json: (id) => JSON.stringify({ id, type: 'e1', owner: id < 100 ? 0 : 1, building: id === 50, carrier: NONE }) });
  const { input, hotkeys } = await makeInput({ game });
  const press = (digit, mods = {}) =>
    hotkeys.handle({ code: `Digit${digit}`, key: digit, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: { tagName: 'BODY' }, preventDefault() {}, ...mods });
  input.setSelection([1, 2, 50, 200]);
  press('1', { ctrlKey: true });
  assert.deepEqual(input.groups.members('1'), [1, 2, 50], 'own units and structures, not the enemy');
  input.setSelection([3]);
  press('1', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(input.groups.members('1'), [1, 2, 50, 3], 'Ctrl+Shift adds the selection');
  input.setSelection([4]);
  press('2', { ctrlKey: true });
  press('2', { shiftKey: true });
  assert.deepEqual(input.selection, [4], 'combining with its own group adds nothing new');
  press('1', { shiftKey: true });
  assert.deepEqual(input.selection, [4, 1, 2, 50, 3], 'Shift adds group 1');
  press('2');
  assert.deepEqual(input.selection, [4]);
  input.setSelection([]);
  press('3', { ctrlKey: true });
  assert.equal(input.groups.has('3'), false, 'nothing selected: no group');
  press('3');
  assert.deepEqual(input.selection, [], 'an empty group selects nothing');
  const cam = { ...input.camera };
  press('1', { altKey: true });
  await new Promise((r) => setImmediate(r));
  assert.notDeepEqual(input.camera, cam, 'Alt jumps to the group');
  assert.deepEqual(input.selection, [], 'without selecting it');
  input.setSelection([2]);
  hotkeys.run('removeFromControlGroup');
  assert.deepEqual(input.groups.members('1'), [1, 50, 3]);
});

test('control groups reach the engine for the selection box numbers, and dead members drop out', async () => {
  let dead = new Set();
  const game = fakeGame({
    actor_json: (id) => (dead.has(id) ? 'null' : JSON.stringify({ id, type: 'e1', owner: 0, building: id === 50, carrier: NONE })),
  });
  const { input, hotkeys } = await makeInput({ game });
  const press = (digit, mods = {}) =>
    hotkeys.handle({ code: `Digit${digit}`, key: digit, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: { tagName: 'BODY' }, preventDefault() {}, ...mods });
  const sent = () => game.calls.filter((c) => c[0] === 'set_control_groups');
  const last = () => sent().at(-1)?.slice(1);
  input.setSelection([1, 50]);
  press('3', { ctrlKey: true });
  assert.deepEqual(last(), [[1, 50], [3, 3]], 'a unit and a structure in group 3');
  input.setSelection([2]);
  press('0', { ctrlKey: true });
  assert.deepEqual(last(), [[1, 50, 2], [3, 3, 0]]);
  const n = sent().length;
  press('3');
  input.refreshSelection();
  assert.equal(sent().length, n, 'selecting a group changes nothing to send');
  input.setSelection([1]);
  press('0', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(last(), [[50, 2, 1], [3, 0, 0]], 'adding to group 0 takes the unit out of group 3');
  hotkeys.run('removeFromControlGroup');
  assert.deepEqual(last(), [[50, 2], [3, 0]]);
  dead = new Set([50]);
  input.refreshSelection();
  assert.deepEqual(last(), [[2], [0]], 'a destroyed structure loses its number');
});

test('the arrow keys scroll while held (OpenRA MapScroll hotkeys)', async () => {
  const { input, hotkeys } = await makeInput();
  input.mapPx = { w: 5000, h: 5000 };
  const down = { code: 'ArrowRight', key: 'ArrowRight', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: { tagName: 'BODY' }, preventDefault() {} };
  hotkeys.handle(down);
  assert.equal(hotkeys.isHeld('mapScrollRight'), true);
  const x = input.camera.x;
  input.update(0.1);
  assert.ok(input.camera.x > x);
  hotkeys.release(down);
  assert.equal(hotkeys.isHeld('mapScrollRight'), false);
  hotkeys.handle(down);
  hotkeys.releaseAll();
  assert.equal(hotkeys.isHeld('mapScrollRight'), false);
});

// ---- Radar pings and the last event ---------------------------------------------------------

const event = (kind, a, x, y, owner, b = 0) => [kind, a, x, y, owner, b];

test('radar pings: own and allied attacks (throttled), beacons and superweapons; the last is where Space goes', () => {
  const pings = new RadarPings({ visible: (o) => o === 0 || o === 2, color: (o) => [o, 0, 0], pxPerWorld: 0.5, tickMs: 40 });
  assert.equal(pings.last(), null);
  pings.onEvents([...event(EV.BUILDING_DAMAGED, 1, 100, 200, 0), ...event(EV.BUILDING_DAMAGED, 1, 300, 300, 1)], 1000);
  assert.deepEqual(pings.last(), { x: 50, y: 100 }, 'enemy structures are not ours to ping');
  pings.onEvents(event(EV.BUILDING_DAMAGED, 1, 900, 900, 0), 1000 + STRUCTURE_INTERVAL_MS - 1);
  assert.deepEqual(pings.last(), { x: 50, y: 100 }, 'at most every 30 seconds');
  pings.onEvents(event(EV.UNIT_DAMAGED, 1, 400, 400, 2), 2000);
  assert.deepEqual(pings.last(), { x: 200, y: 200 }, "an ally's unit");
  pings.onEvents(event(EV.UNIT_DAMAGED, 1, 500, 500, 2), 2000 + UNIT_INTERVAL_MS);
  assert.deepEqual(pings.last(), { x: 250, y: 250 }, 'units ping every 10 seconds');
  pings.onEvents(event(EV.BEACON_PLACED, 0, 20, 40, 2, 750), 3000);
  assert.deepEqual(pings.last(), { x: 10, y: 20 });
  const nuke = POWER_KINDS.indexOf('NukePower');
  const spy = POWER_KINDS.indexOf('AirstrikePower');
  pings.onEvents(event(EV.POWER_ACTIVATED, spy, 60, 60, 0), 3100);
  assert.deepEqual(pings.last(), { x: 10, y: 20 }, 'only powers with DisplayRadarPing');
  pings.onEvents(event(EV.POWER_ACTIVATED, nuke, 60, 60, 0), 3200);
  assert.deepEqual(pings.last(), { x: 30, y: 30 });
  // Pings shrink and go away after their duration.
  const beacon = pings.active(3000).find((p) => p.x === 10);
  assert.equal(beacon.radius, FROM_RADIUS);
  assert.equal(pings.active(3000 + 100 * 40).find((p) => p.x === 10).radius, TO_RADIUS);
  assert.equal(pings.active(1000 + PING_TICKS * 40).some((p) => p.x === 50 && p.y === 100), false);
  assert.equal(RadarPings.triangle(0, 0, 10, 0).length, 3);
  assert.equal(STRIDE, 6);
});

test('the sidebar mode sounds and announcements', async () => {
  const { Director } = await import('../js/audio/director.js');
  const effects = [];
  const lines = [];
  const d = new Director({
    rules: { actors: [{ id: 'POWR', kind: 'building' }], weapons: [] },
    player: 0,
    side: 'allies',
    pxPerWorld: 1,
    lookup: () => null,
    sink: { effect: (s) => effects.push(s.synth), voice() {}, announce: (k) => lines.push(k), notify: (name) => effects.push(name) },
    now: () => 10,
    allied: (o) => o === 0 || o === 1,
  });
  d.onEvents(
    [
      ...event(EV.REPAIR_STARTED, 0, 0, 0, 0, 1),
      ...event(EV.REPAIR_STARTED, 0, 0, 0, 1, 1),
      ...event(EV.POWER_TOGGLED, 0, 0, 0, 0, 1),
      ...event(EV.POWER_TOGGLED, 0, 0, 0, 0, 0),
      ...event(EV.BEACON_PLACED, 0, 0, 0, 1, 750),
      ...event(EV.BEACON_PLACED, 0, 0, 0, 2, 750),
    ],
    { x0: 0, y0: 0, x1: 100, y1: 100 },
  );
  assert.deepEqual(lines, ['repairing'], 'to the player who repairs');
  assert.deepEqual(effects, ['DisablePower', 'EnablePower', 'Beacon'], "OpenRA's notifications; an enemy's beacon makes no sound");
});

// ---- Chat keys, observer panels ---------------------------------------------------------------

test('chat keys: team chat needs a team mate (spectators have the others); names complete', () => {
  const slots = [
    { type: 'human', team: 1 },
    { type: 'human', team: 1 },
    { type: 'ai', team: 2 },
    { type: 'human', team: 0 },
  ];
  assert.equal(hasTeamChat(slots, 0), true);
  assert.equal(hasTeamChat(slots, 3), false, 'no team');
  assert.equal(hasTeamChat([{ type: 'human', team: 2 }, { type: 'ai', team: 2 }], 0), false, 'an AI does not read chat');
  assert.equal(hasTeamChat(slots, null), true, 'spectators');
  assert.equal(chatMode(true, false), 'all');
  assert.equal(chatMode(true, true), 'team');
  assert.equal(chatMode(false, true), 'all');
  const names = ['Tanya', 'tank boy', 'Volkov'];
  let r = completeName('gg ta', names);
  assert.equal(r.text, 'gg Tanya');
  r = completeName(r.text, names, r.state);
  assert.equal(r.text, 'gg tank boy', 'Tab again: the next match');
  r = completeName(r.text, names, r.state);
  assert.equal(r.text, 'gg Tanya');
  assert.equal(completeName('hi x', names), null);
  assert.equal(completeName('hi ', names), null);
});

test('observer panels: OpenRA statistics, icons for production, powers and army; graph samples', () => {
  assert.deepEqual(PANEL_ORDER, ['none', 'basic', 'economy', 'production', 'supportPowers', 'combat', 'army', 'graph', 'armyGraph']);
  assert.equal(PANELS.none.columns, undefined);
  // The icon panels are tested in observer-icons.test.mjs.
  assert.deepEqual(
    ['production', 'supportPowers', 'army'].map((p) => PANELS[p].icons),
    ['production', 'powers', 'army'],
  );
  const h = new History(4);
  for (let t = 0; t < 10; t++) h.sample(0, t, t * 10);
  assert.ok(h.series.get(0).length <= 5, 'thinned out');
  assert.deepEqual(h.series.get(0).at(-1), [9, 90], 'the newest sample stays');
  h.sample(0, 2, 5);
  assert.deepEqual(h.series.get(0), [[2, 5]], 'seeking back starts over');
});
