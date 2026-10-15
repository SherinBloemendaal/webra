// Picking start positions on the lobby map previews (js/spawnpick.js,
// js/lobby-state.js, js/lobby.js, js/online.js), like OpenRA's lobby: what a
// click does (yours, the host's AI players, taken spawns, freeing), the
// tooltip, the keyboard, the lens, the skirmish lobby's state and start
// options, and the online lobby's messages. Synthetic maps only.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeEvent, installDom, uninstallDom } from './dom-fixtures.mjs';
import { SpawnMarkers, localSlots, pickedBy, spawnAction, spawnTip } from '../js/spawnpick.js';
import {
  addSlot,
  battlefieldKey,
  buildOptions,
  clearSpawnPicks,
  sanitizeState,
  setSlotType,
  setSpawnPick,
  settleSpawnPicks,
  spawnMarkers,
  startProblem,
  storedSettings,
} from '../js/lobby-state.js';
import { defaultRegistry } from '../js/registry.js';

afterEach(() => {
  delete globalThis.requestAnimationFrame;
  uninstallDom();
});

const COLORS = Array.from({ length: 8 }, (_, k) => [k / 8, 0.5, 1 - k / 8]);
const CORNERS = [[4, 4], [40, 40], [40, 4], [4, 40]];
const fresh = () => sanitizeState(null, 8, () => 42);
const slots = (...list) => list.map(([type, spawn]) => ({ type, ...(spawn === undefined ? {} : { spawn }) }));

// ---- What a click does -------------------------------------------------------------------

test("OpenRA's rules: a free spawn moves the first of your slots without a pick, a taken one does nothing", () => {
  // You (slot 0) as a guest: only your own slot.
  const lobby = slots(['human'], ['human'], ['ai'], ['open']);
  assert.deepEqual(localSlots(lobby, 0, false), [0]);
  assert.deepEqual(spawnAction(lobby, 2, { you: 0, host: false }), { slot: 0, spawn: 2 });
  // The host: itself first, then its AI players in slot order, then itself again.
  const hosted = slots(['ai'], ['human'], ['ai'], ['human']);
  assert.deepEqual(localSlots(hosted, 1, true), [0, 1, 2]);
  assert.deepEqual(spawnAction(hosted, 0, { you: 1, host: true }), { slot: 1, spawn: 0 }, 'you before the bots you host');
  hosted[1].spawn = 0;
  assert.deepEqual(spawnAction(hosted, 3, { you: 1, host: true }), { slot: 0, spawn: 3 }, 'then the first AI without one');
  hosted[0].spawn = 3;
  hosted[2].spawn = 2;
  assert.deepEqual(spawnAction(hosted, 1, { you: 1, host: true }), { slot: 1, spawn: 1 }, 'all placed: you move');
  // Taken by someone who is not yours: nothing.
  const taken = slots(['human'], ['human', 1]);
  assert.equal(pickedBy(taken, 1), 1);
  assert.equal(spawnAction(taken, 1, { you: 0, host: false }), null);
  assert.equal(spawnAction(taken, 1, { you: 0, host: true }), null, 'the host cannot take a player\'s spawn either');
  // A spectator who is not the host picks nothing.
  assert.equal(spawnAction(slots(['human'], ['ai']), 0, { you: -1, host: false }), null);
});

test('freeing: clicking your own spawn again, right-click (the host frees anyone), Delete counts as right-click', () => {
  const lobby = slots(['human', 0], ['human', 1], ['ai', 2]);
  assert.deepEqual(spawnAction(lobby, 0, { you: 0, host: false }), { slot: 0, spawn: null }, 'your own again: automatic');
  assert.deepEqual(spawnAction(lobby, 0, { you: 0, host: false, button: 'right' }), { slot: 0, spawn: null });
  assert.equal(spawnAction(lobby, 1, { you: 0, host: false, button: 'right' }), null, 'a guest frees only its own');
  assert.deepEqual(spawnAction(lobby, 1, { you: 0, host: true, button: 'right' }), { slot: 1, spawn: null }, 'OpenRA clear_spawn');
  assert.deepEqual(spawnAction(lobby, 2, { you: 0, host: true }), { slot: 2, spawn: null }, "the host's AI: a click frees it");
  assert.equal(spawnAction(lobby, 3, { you: 0, host: true, button: 'right' }), null, 'an empty spawn: nothing to free');
});

test('the tooltip names who starts there and what a click does', () => {
  const lobby = [
    { type: 'human', name: 'Me', team: 0 },
    { type: 'ai', team: 2, spawn: 1 },
  ];
  const opts = { you: 0, host: true, nameOf: (k) => (k === 1 ? 'Rush AI' : 'Me') };
  const markerOf = (index, slot, picked) => ({ index, letter: 'ABCD'[index], slot, picked });
  let tip = spawnTip(markerOf(1, 1, true), lobby, opts);
  assert.equal(tip.title, 'Start position B');
  assert.match(tip.desc, /Rush AI \(P2, team 2\) starts here \(picked\)\./);
  assert.match(tip.desc, /Click to free it for P2\./);
  tip = spawnTip(markerOf(0, 0, false), lobby, opts);
  assert.match(tip.desc, /You \(P1\) start here \(automatic: moves on/);
  assert.match(tip.desc, /Click to start here\./);
  tip = spawnTip(markerOf(2, null, false), lobby, { ...opts, enabled: false });
  assert.equal(tip.desc, 'Nobody starts here.', 'no actions when picking is off');
  const guest = spawnTip(markerOf(1, 1, true), lobby, { ...opts, host: false });
  assert.match(guest.desc, /Taken\./);
});

// ---- The skirmish lobby's state --------------------------------------------------------------

test('lobby state: picks are checked, kept in the options and the stored lobby, and cleared with the battlefield', () => {
  const s = fresh();
  addSlot(s, 8);
  addSlot(s, 8);
  assert.equal(setSpawnPick(s, 2, 1, 4), true);
  assert.equal(setSpawnPick(s, 0, 1, 4), false, 'taken');
  assert.equal(setSpawnPick(s, 0, 4, 4), false, 'past the last spawn');
  assert.equal(setSpawnPick(s, 0, 3, 4), true);
  // The markers: picked ones where picked, the others fill in.
  const markers = spawnMarkers(CORNERS, 48, 48, s);
  assert.deepEqual(markers.map((m) => [m.letter, m.slot, m.picked]), [['A', 1, false], ['B', 2, true], ['C', 3, false], ['D', 0, true]]);
  // The engine gets them; a stored lobby keeps them.
  assert.deepEqual(buildOptions(s).players.map((p) => p.spawn), [3, undefined, 1, undefined]);
  const back = sanitizeState(JSON.parse(JSON.stringify(storedSettings(s))), 8, () => 0);
  assert.deepEqual(back.players.map((p) => p.spawn), [3, undefined, 1, undefined]);
  // A closed slot plays nowhere.
  setSlotType(s, 2, 'closed');
  assert.equal(s.players[2].spawn, undefined);
  // The battlefield: map file by hash, generated map by seed, size, style and players.
  const key = battlefieldKey(s);
  assert.equal(key, `gen:${s.seed}/${s.mapSize}/${s.mapStyle}/3`);
  assert.notEqual(battlefieldKey({ ...s, seed: s.seed + 1 }), key);
  assert.equal(battlefieldKey({ ...s, mapSource: 'file' }, 'h'), 'map:h');
  assert.equal(clearSpawnPicks(s), true);
  assert.deepEqual(s.players.map((p) => p.spawn), [undefined, undefined, undefined, undefined]);
  // A smaller map drops the picks it cannot hold, and doubles.
  s.players[0].spawn = 5;
  s.players[1].spawn = 1;
  s.players[3].spawn = 1;
  settleSpawnPicks(s, 4);
  assert.deepEqual(s.players.map((p) => p.spawn), [undefined, 1, undefined, undefined]);
});

test('lobby state: the start refuses picks the battlefield cannot take', () => {
  const s = fresh();
  s.players[0].spawn = 2;
  assert.match(startProblem(s, null), /picked start position C; this map has 2/, 'a generated 2 player map has spawns A and B');
  s.players[0].spawn = 1;
  assert.equal(startProblem(s, null), null);
  s.players[1].spawn = 1;
  assert.match(startProblem(s, null), /Two players picked start position B/);
});

// ---- The markers on a page ---------------------------------------------------------------------

/** A recording lens: hot markers, markers, holds. */
function fakeLens() {
  return { hot: [], markers: null, held: false, setHotMarker(k) { this.hot.push(k); }, setMarkers(m) { this.markers = m; }, heldRecently() { return this.held; } };
}

test('markers are buttons: click, right-click and Delete pick and free; focus and hover ring the marker in the lens; a lens hold is not a tap', () => {
  const doc = installDom();
  const layer = doc.createElement('div');
  doc.body.append(layer);
  const lens = fakeLens();
  const picks = [];
  const markersView = new SpawnMarkers(layer, { lens, onPick: (a) => picks.push(a) });
  const state = fresh();
  const list = spawnMarkers(CORNERS.slice(0, 2), 48, 48, state);
  const view = { slots: state.players, you: 0, host: true, colors: COLORS, nameOf: () => 'Normal AI', enabled: true };
  markersView.render(list, view);
  const buttons = [...layer.querySelectorAll('button.spawn-marker')];
  assert.equal(buttons.length, 2);
  assert.deepEqual(buttons.map((b) => b.textContent), ['A', 'B']);
  assert.match(buttons[0].getAttribute('aria-label'), /^Start position A: You \(P1\) start here/);
  assert.ok(buttons[0].classList.contains('spawn-marker-you') && buttons[0].classList.contains('spawn-marker-auto'));
  assert.deepEqual(lens.markers.map((m) => [m.label, m.picked]), [['A', false], ['B', false]], 'mirrored into the lens');
  buttons[1].click();
  assert.deepEqual(picks.at(-1), { slot: 0, spawn: 1 }, 'a click takes the spawn');
  // Right-click and Delete free a picked spawn (the context menu stays shut).
  state.players[1].spawn = 0;
  markersView.render(spawnMarkers(CORNERS.slice(0, 2), 48, 48, state), view);
  const [a] = [...layer.querySelectorAll('button.spawn-marker')];
  const menu = new FakeEvent('contextmenu', { cancelable: true });
  a.dispatchEvent(menu);
  assert.equal(menu.defaultPrevented, true);
  assert.deepEqual(picks.at(-1), { slot: 1, spawn: null });
  const del = new FakeEvent('keydown', { key: 'Delete', cancelable: true });
  a.dispatchEvent(del);
  assert.equal(del.defaultPrevented, true);
  assert.equal(picks.length, 3);
  // Hover and focus tell the lens which marker a click picks.
  a.dispatchEvent(new FakeEvent('pointerenter'));
  a.dispatchEvent(new FakeEvent('pointerleave'));
  a.focus();
  a.dispatchEvent(new FakeEvent('focus'));
  assert.deepEqual(lens.hot, [0, -1, 0]);
  // Focus survives a redraw (a lobby update).
  markersView.render(spawnMarkers(CORNERS.slice(0, 2), 48, 48, state), view);
  assert.equal(doc.activeElement, layer.querySelectorAll('button.spawn-marker')[0]);
  // Lifting a finger after a lens hold is not a tap, and its context menu is not a right click.
  lens.held = true;
  layer.querySelectorAll('button.spawn-marker')[1].click();
  layer.querySelectorAll('button.spawn-marker')[0].dispatchEvent(new FakeEvent('contextmenu', { cancelable: true }));
  assert.equal(picks.length, 3);
  lens.held = false;
  // A long press without the lens (no engine): the touch's context menu frees nothing either.
  const held = layer.querySelectorAll('button.spawn-marker')[0];
  held.dispatchEvent(new FakeEvent('pointerdown', { pointerType: 'touch' }));
  const touchMenu = new FakeEvent('contextmenu', { cancelable: true });
  held.dispatchEvent(touchMenu);
  assert.equal(touchMenu.defaultPrevented, true, 'no browser menu');
  held.dispatchEvent(new FakeEvent('contextmenu', { cancelable: true, pointerType: 'touch' }));
  assert.equal(picks.length, 3);
  // A real right click with the mouse still frees it.
  held.dispatchEvent(new FakeEvent('pointerdown', { pointerType: 'mouse', button: 2 }));
  held.dispatchEvent(new FakeEvent('contextmenu', { cancelable: true, pointerType: 'mouse' }));
  assert.deepEqual(picks.at(-1), { slot: 1, spawn: null });
  assert.equal(picks.length, 4);
  // Picking off (a resumed save, a spectator): nothing happens, the markers still say who starts where.
  markersView.render(spawnMarkers(CORNERS.slice(0, 2), 48, 48, state), { ...view, enabled: false });
  const off = layer.querySelectorAll('button.spawn-marker')[1];
  assert.equal(off.getAttribute('aria-disabled'), 'true');
  off.click();
  assert.equal(picks.length, 4);
});

test('skirmish lobby: a click on a marker picks the spawn, the start list follows, the game gets it; a new seed clears it', async () => {
  const doc = installDom();
  globalThis.requestAnimationFrame = () => 1;
  globalThis.ImageData ??= class {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  };
  const root = doc.createElement('section');
  doc.body.append(root);
  defaultRegistry().set('lobby', 'lastOptions', {});
  const { Lobby } = await import('../js/lobby.js');
  const started = [];
  const asked = [];
  const lobby = new Lobby(root, {
    colors: COLORS,
    colorNames: [],
    maps: {
      preview: (seed, size) => new Uint8Array(size * size * 4),
      spawns: (seed, size, players, style) => (asked.push(style), [[4, 4], [40, 40], [40, 4], [4, 40]].slice(0, players)),
      validate: () => ({ ok: true, errors: [], modded: false, hash: 'h' }),
      filePreview: () => new Uint8Array(0),
    },
    onStart: (o) => started.push(o),
    onStress: () => {},
  });
  lobby.canvas.getContext = () => ({ putImageData() {}, clearRect() {} });
  lobby.ctx = lobby.canvas.getContext();
  lobby.drawPreview();
  assert.equal(asked.at(-1), lobby.state.mapStyle, 'the spawns of the map style shown');
  let markers = [...root.querySelectorAll('.lobby-markers button.spawn-marker')];
  assert.deepEqual(markers.map((b) => b.textContent), ['A', 'B']);
  const list = () => lobby.slotRows[0].spawn;
  assert.deepEqual([...list().querySelectorAll('option')].map((o) => o.textContent), ['Automatic (A)', 'Position A', 'Position B']);
  // You click B: you start there, the AI moves to A.
  markers[1].click();
  assert.equal(lobby.state.players[0].spawn, 1);
  lobby.drawPreview();
  markers = [...root.querySelectorAll('.lobby-markers button.spawn-marker')];
  assert.ok(markers[1].classList.contains('spawn-marker-picked'));
  assert.equal(list().value, '1');
  assert.deepEqual([...lobby.slotRows[1].spawn.querySelectorAll('option')].map((o) => o.textContent), ['Automatic (A)', 'Position A'], 'B is yours: not offered to the AI');
  // The host places its AI through its list (keyboard path).
  lobby.slotRows[1].spawn.value = '0';
  lobby.slotRows[1].spawn.dispatchEvent(new FakeEvent('change'));
  assert.equal(lobby.state.players[1].spawn, 0);
  lobby.start();
  assert.deepEqual(started.at(-1).players.map((p) => p.spawn), [1, 0]);
  // Clicking your own again frees it.
  lobby.drawPreview();
  root.querySelectorAll('.lobby-markers button.spawn-marker')[1].click();
  assert.equal(lobby.state.players[0].spawn, undefined);
  // A new seed is a new map: the picks go.
  lobby.seedInput.value = String(lobby.state.seed + 1);
  lobby.seedInput.dispatchEvent(new FakeEvent('input'));
  lobby.drawPreview();
  assert.equal(lobby.state.players[1].spawn, undefined);
});

test('online lobby: markers on the preview send slot messages; the host frees a player with a right-click', async () => {
  installDom();
  globalThis.ImageData ??= class {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  };
  const { OnlineUI } = await import('../js/online.js');
  const sent = [];
  const error = console.error;
  console.error = () => {};
  try {
    const ui = Object.create(OnlineUI.prototype);
    const spawns = [[4, 4], [40, 40], [40, 4]];
    Object.assign(ui, {
      lens: null,
      ctx: {
        colors: COLORS,
        Game: { map_preview_styled: (seed, size) => new Uint8Array(size * size * 4), generated_map_styled: (seed, size, players) => JSON.stringify({ spawns: spawns.slice(0, players) }) },
      },
      installed: new Map(),
      missionPreviews: new Map(),
      mapStatus: { text: '', ok: true },
      mapNotice: null,
      mapOffer: null,
      mapBox: globalThis.document.createElement('section'),
      send: (m) => sent.push(m),
      libraryMaps: [],
      serverMaps: [],
      state: {
        you: 1,
        hostId: 1,
        slots: [{ type: 'human', client: 1, name: 'Host', faction: 'random', color: 0, team: 0 }, { type: 'human', client: 2, name: 'Guest', faction: 'random', color: 1, team: 0, spawn: 1 }, { type: 'open' }],
        options: { seed: 9, mapSize: 64, mapStyle: 'land', biome: 'snow', techBuildings: 'standard', separateTeamSpawns: true },
        map: null,
        mission: null,
        spectators: [],
      },
    });
    ui.markerList = ui.lobbyMarkers();
    assert.deepEqual(ui.markerList.map((m) => [m.letter, m.slot, m.picked]), [['A', 0, false], ['B', 1, true]], 'one spawn per player of a generated map');
    ui.renderMap();
    const markers = [...ui.mapBox.querySelectorAll('button.spawn-marker')];
    assert.equal(markers.length, 2);
    markers[1].click();
    assert.deepEqual(sent, [], 'taken by the guest');
    markers[1].dispatchEvent(new FakeEvent('contextmenu', { cancelable: true }));
    assert.deepEqual(sent.at(-1), { t: 'slot', slot: 1, spawn: null }, 'the host frees it (OpenRA clear_spawn)');
    markers[0].click();
    assert.deepEqual(sent.at(-1), { t: 'slot', slot: 0, spawn: 0 }, 'the host picks its own');
    // A host alone: the two player map, as the server counts it.
    const { Room } = await import('../../server/src/room.js');
    ui.state.slots = [ui.state.slots[0], { type: 'open' }, { type: 'open' }];
    ui.spawnCells = null;
    const solo = ui.lobbyMarkers();
    const room = Room.create({ maxPlayers: 3, seed: 9 });
    room.join('Host', { host: true });
    assert.equal(solo.length, room.spawnCount(), 'client and server agree on the spawns');
    assert.equal(solo.length, 2);
    // A co-op mission places everyone itself: no markers.
    ui.state.mission = { id: 'evacuation', hash: 'h', options: {} };
    assert.deepEqual(ui.lobbyMarkers(), []);
  } finally {
    console.error = error;
  }
});
