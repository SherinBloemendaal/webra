// Test play from the map editor: the setup it hands over next to the map
// (js/maploader.js loadTestSetup), the lobby taking the slots and bots and
// starting at once, and the checks on what it is given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';
import { installDom, uninstallDom } from './dom-fixtures.mjs';
import { TEST_SETUP_KEY, loadTestSetup } from '../js/maploader.js';
import { defaultRegistry } from '../js/registry.js';
import { createMap } from '../editor/js/mapformat.js';

initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });

const params = (q) => new URLSearchParams(q);
const storage = (value) => ({ getItem: (k) => (k === TEST_SETUP_KEY ? value : null) });
const players = [
  { type: 'human', faction: 'england', difficulty: 'normal', bot: 'normal', team: 0 },
  { type: 'ai', faction: 'russia', difficulty: 'hard', bot: 'turtle', team: 0 },
  { type: 'closed', faction: 'random', difficulty: 'normal', bot: 'normal', team: 0 },
];

test('the setup is read only for editor test play, and only in a sane shape', () => {
  const ok = JSON.stringify({ players, camera: [120.5, 300], autostart: true });
  const s = loadTestSetup(params('editorTest=1'), storage(ok));
  assert.deepEqual(s.camera, [120.5, 300]);
  assert.equal(s.autostart, true);
  assert.equal(s.players.length, 3);
  assert.equal(loadTestSetup(params('map=abc'), storage(ok)), null, 'not for a linked map');
  assert.equal(loadTestSetup(params('editorTest=1'), storage(null)), null);
  assert.equal(loadTestSetup(params('editorTest=1'), storage('{bad')), null);
  assert.equal(loadTestSetup(params('editorTest=1'), storage(JSON.stringify({ players: [players[0]] }))), null, 'two slots at least');
  const odd = loadTestSetup(params('editorTest=1'), storage(JSON.stringify({ players: [...players, 'x'], camera: ['a', 1], autostart: 'yes', extra: 1 })));
  assert.equal(odd.camera, null);
  assert.equal(odd.autostart, false);
  assert.deepEqual(odd.players[3], {});
  assert.equal(loadTestSetup(params('editorTest=1'), { getItem: () => { throw new Error('blocked'); } }), null, 'blocked storage: the lobby opens as usual');
});

/** A 2-spawn map file the engine accepts. */
function mapJson(spawns = [[8, 8], [80, 80]]) {
  return JSON.stringify({ ...createMap({ width: 96, height: 96, name: 'Test', author: 'A' }), spawns });
}

async function mountLobby() {
  const doc = installDom();
  globalThis.requestAnimationFrame = () => 1;
  const root = doc.createElement('section');
  doc.body.append(root);
  defaultRegistry().set('lobby', 'presets', []);
  defaultRegistry().set('lobby', 'lastOptions', {});
  const { Lobby } = await import('../js/lobby.js');
  const started = [];
  const lobby = new Lobby(root, {
    colors: Array.from({ length: 8 }, () => [1, 1, 1]),
    colorNames: [],
    mapPreview: () => new Uint8Array(0),
    maps: { validate: (json) => JSON.parse(Game.validate_map(json)) },
    onStart: (o) => started.push(o),
    onStress: () => {},
  });
  return { lobby, started };
}

test('the lobby takes the slots and bots, checks them, and starts at once', async () => {
  const { lobby, started } = await mountLobby();
  try {
    lobby.offerMapText(mapJson([[8, 8], [80, 80], [8, 80]]), 'editor', { players, camera: null, autostart: true });
    assert.deepEqual(lobby.state.players.map((p) => [p.type, p.faction]), [['human', 'england'], ['ai', 'russia'], ['closed', 'random']]);
    assert.deepEqual([lobby.state.players[1].difficulty, lobby.state.players[1].bot], ['hard', 'turtle']);
    assert.equal(new Set(lobby.state.players.map((p) => p.color)).size, 3, 'distinct colours');
    await Promise.resolve();
    assert.equal(started.length, 1, 'started right away');
    assert.equal(started[0].players.filter((p) => p.type === 'ai').length, 1);
    assert.ok(started[0].map, 'on the editor map');
  } finally {
    delete globalThis.requestAnimationFrame;
    uninstallDom();
  }
});

test('a setup with more slots than the map has starts, or with bad values, is cut down and repaired', async () => {
  const { lobby, started } = await mountLobby();
  try {
    const bad = [
      { type: 'ai', faction: 'moon', difficulty: 'godlike', bot: 'cheater', team: 99 },
      { type: 'ai', faction: 'russia', difficulty: 'easy', bot: 'rush', team: 1 },
      { type: 'human', faction: 'france', difficulty: 'normal', bot: 'normal', team: 0 },
    ];
    lobby.offerMapText(mapJson(), 'editor', { players: bad, camera: null, autostart: false });
    assert.equal(lobby.state.players.length, 2, 'two starts: two slots');
    assert.ok(lobby.state.players.some((p) => p.type === 'human'), 'one slot is the player');
    for (const p of lobby.state.players) assert.ok(p.faction !== 'moon' && (p.team ?? 0) <= 4);
    await Promise.resolve();
    assert.equal(started.length, 0, 'the lobby waits without autostart');
  } finally {
    delete globalThis.requestAnimationFrame;
    uninstallDom();
  }
});
