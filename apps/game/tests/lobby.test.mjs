// Skirmish lobby rules (js/lobby-state.js): stored-settings migration, slots,
// teams, start checks, the onStart options shape and map files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';
import {
  MAX_SLOTS,
  MAP_FILE_MAX_BYTES,
  sanitizeState,
  addSlot,
  canAddSlot,
  removeSlot,
  canRemoveSlot,
  setSlotType,
  setColor,
  activeCount,
  startProblem,
  buildOptions,
  storedSettings,
  minMapSize,
  suggestedMapSize,
  inspectMapFile,
  spawnMarkers,
} from '../js/lobby-state.js';

initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });

const COLORS = 8;
const fresh = () => sanitizeState(null, COLORS, () => 42);
const validate = (json) => JSON.parse(Game.validate_map(json));

test('settings stored by the two-slot lobby (v1) carry over', () => {
  const v1 = {
    seed: 77,
    mapSize: 128,
    players: [
      { slot: 0, type: 'human', name: 'Tanya', faction: 'england', color: 3 },
      { slot: 1, type: 'ai', difficulty: 'hard', faction: 'ukraine', color: 5 },
    ],
    startingCash: 10000,
    startingUnits: 'base',
    techLevel: 'low',
    gameSpeed: 'fast',
    fog: false,
    explored: true,
    buildRadius: false,
    redeployableMcv: false,
    oreRegrowth: false,
    stressUnits: 500,
  };
  const s = sanitizeState(v1, COLORS, () => 1);
  assert.equal(s.seed, 77);
  assert.equal(s.mapSize, 128);
  assert.equal(s.mapSource, 'random');
  assert.deepEqual(
    s.players.map((p) => [p.type, p.faction, p.color, p.team]),
    [
      ['human', 'england', 3, 0],
      ['ai', 'ukraine', 5, 0],
    ],
  );
  assert.equal(s.players[0].name, 'Tanya');
  assert.equal(s.players[1].difficulty, 'hard');
  assert.equal(s.stressUnits, 500);
  assert.equal(s.fog, false);
});

test('broken stored settings become a valid lobby', () => {
  const s = sanitizeState(
    {
      seed: -5,
      mapSize: 100,
      players: [
        { type: 'ai', color: 2 },
        { type: 'human', name: '   ', color: 2, team: 9 },
        { type: 'human', faction: 'atlantis', color: 99 },
        ...Array.from({ length: 10 }, () => ({ type: 'closed' })),
      ],
    },
    COLORS,
    () => 9,
  );
  assert.equal(s.seed, 9);
  assert.equal(s.mapSize, 96);
  assert.equal(s.players.length, MAX_SLOTS);
  assert.equal(s.players.filter((p) => p.type === 'human').length, 1, 'one human');
  assert.equal(s.players[1].type, 'human', 'the first stored human stays');
  assert.equal(s.players[1].name, 'Commander');
  assert.equal(s.players[1].team, 0);
  assert.ok(activeCount(s) >= 2);
  assert.equal(new Set(s.players.map((p) => p.color)).size, s.players.length, 'unique colours');
  assert.ok(s.players.every((p) => p.color >= 0 && p.color < COLORS));
  assert.equal(s.players[2].faction, 'random');

  const allClosed = sanitizeState({ players: [{ type: 'closed' }, { type: 'closed' }] }, COLORS, () => 1);
  assert.deepEqual(
    allClosed.players.map((p) => p.type),
    ['human', 'ai'],
  );
  assert.equal(sanitizeState('nonsense', COLORS, () => 1).players.length, 2);
});

test('slots: add up to eight with free colours, remove down to two', () => {
  const s = fresh();
  while (canAddSlot(s)) addSlot(s, COLORS);
  assert.equal(s.players.length, 8);
  assert.equal(addSlot(s, COLORS), -1);
  assert.equal(new Set(s.players.map((p) => p.color)).size, 8);
  assert.equal(canRemoveSlot(s, 0), false, 'never the human');
  while (s.players.length > 2) assert.ok(removeSlot(s, s.players.length - 1));
  assert.equal(canRemoveSlot(s, 1), false, 'two players minimum');
  // A map file with three start positions limits the slots.
  addSlot(s, COLORS, 3);
  assert.equal(canAddSlot(s, 3), false);
});

test('slot types: one human that can move, closing keeps two players', () => {
  const s = fresh();
  addSlot(s, COLORS);
  s.players[0].name = 'Boris';
  assert.equal(setSlotType(s, 0, 'ai:hard'), false, 'the human slot stays human');
  assert.ok(setSlotType(s, 2, 'human'));
  assert.deepEqual(
    s.players.map((p) => p.type),
    ['ai', 'ai', 'human'],
  );
  assert.equal(s.players[2].name, 'Boris', 'the name moves along');
  assert.equal(s.players[0].difficulty, 'normal');
  assert.ok(setSlotType(s, 1, 'closed'));
  assert.equal(setSlotType(s, 0, 'closed'), false, 'at least two players');
  assert.equal(setSlotType(s, 1, 'ai:expert'), false);
  assert.equal(setSlotType(s, 1, 'ai:easy', 2), false, 'no free start position');
  assert.ok(setSlotType(s, 1, 'ai:easy'));
  assert.equal(s.players[1].difficulty, 'easy');
});

test('colours swap when taken', () => {
  const s = fresh();
  const [a, b] = [s.players[0].color, s.players[1].color];
  assert.ok(setColor(s, 0, b));
  assert.deepEqual([s.players[0].color, s.players[1].color], [b, a]);
  assert.equal(setColor(s, 0, b), false);
});

test('start checks: teams, players and map files', () => {
  const s = fresh();
  assert.equal(startProblem(s, null), null);
  s.players[0].team = 1;
  s.players[1].team = 1;
  assert.match(startProblem(s, null), /same team/);
  s.players[1].team = 2;
  assert.equal(startProblem(s, null), null);
  s.mapSource = 'file';
  assert.match(startProblem(s, null), /Load a map file/);
  addSlot(s, COLORS);
  assert.match(startProblem(s, { spawns: 2, accepted: true }), /2 start positions/);
  assert.match(startProblem(s, { spawns: 4, accepted: false }), /Accept/);
  assert.equal(startProblem(s, { spawns: 4, accepted: true }), null);
});

test('options keep the lobby contract and add teams, closed slots and the map', () => {
  const s = fresh();
  addSlot(s, COLORS);
  addSlot(s, COLORS);
  setSlotType(s, 2, 'closed');
  s.players[1].team = 2;
  s.players[3].team = 2;
  s.players[3].difficulty = 'hard';
  const o = buildOptions(s, '{"format":1}');
  assert.equal(o.map, null, 'random map: no map file even if one is installed');
  assert.deepEqual(o.players[0], { slot: 0, type: 'human', faction: 'germany', color: 0, team: 0, name: 'Commander' });
  assert.deepEqual(o.players[2], { slot: 2, type: 'closed' });
  assert.deepEqual(o.players[3], { slot: 3, type: 'ai', faction: 'random', color: 3, team: 2, difficulty: 'hard' });
  for (const key of ['seed', 'mapSize', 'startingCash', 'startingUnits', 'techLevel', 'gameSpeed', 'fog', 'explored', 'buildRadius', 'redeployableMcv', 'oreRegrowth']) {
    assert.ok(key in o, key);
  }
  s.mapSource = 'file';
  assert.equal(buildOptions(s, '{"format":1}').map, '{"format":1}');
  const stored = storedSettings(s);
  assert.equal('map' in stored, false, 'the map file is stored on its own');
  assert.equal(stored.mapSource, 'file');
  // What the lobby stores reads back as the same setup.
  const back = sanitizeState(JSON.parse(JSON.stringify(stored)), COLORS, () => 0);
  assert.deepEqual(buildOptions(back, null).players, buildOptions(s, null).players);
});

test('the engine accepts the options with closed slots and teams', () => {
  const s = fresh();
  s.mapSize = 64;
  addSlot(s, COLORS);
  addSlot(s, COLORS);
  setSlotType(s, 1, 'closed');
  s.players[0].team = 1;
  s.players[2].team = 1;
  s.players[3].team = 2;
  s.players[2].faction = 'england';
  s.players[3].faction = 'russia';
  s.players[0].faction = 'germany';
  const game = Game.from_options(JSON.stringify(buildOptions(s)));
  assert.equal(game.player_count(), 3, 'the closed slot does not play');
  const me = JSON.parse(game.player_json(0));
  assert.equal(me.team, 1);
});

test('map sizes grow with the player count', () => {
  assert.equal(minMapSize(2), 64);
  assert.equal(minMapSize(8), 96);
  assert.equal(suggestedMapSize(2), 96);
  assert.equal(suggestedMapSize(6), 128);
  assert.equal(suggestedMapSize(8), 160);
  for (let n = 2; n <= 8; n++) assert.ok(suggestedMapSize(n) >= minMapSize(n));
});

test('map files: valid, modded, broken and too large', () => {
  const json = Game.generated_map(5, 64, 3);
  const info = inspectMapFile(json, validate);
  assert.equal(info.ok, true, info.errors.join('; '));
  assert.equal(info.modded, false);
  assert.equal(info.spawns, 3);
  assert.equal(info.width, 64);
  assert.match(info.hash, /^[0-9a-f]{64}$/);

  const modded = JSON.parse(json);
  modded.rules = { actors: { '1TNK': { cost: 1 } } };
  const m = inspectMapFile(JSON.stringify(modded), validate);
  assert.equal(m.ok, true);
  assert.equal(m.modded, true);

  assert.equal(inspectMapFile('{oops', validate).ok, false);
  assert.match(inspectMapFile('{"format":1}', validate).errors.join(' '), /\w/);
  assert.equal(inspectMapFile('', validate).ok, false);
  assert.match(inspectMapFile('x'.repeat(MAP_FILE_MAX_BYTES + 1), validate).errors[0], /1 MiB/);
});

test('spawn markers follow the playing slots in order', () => {
  const s = fresh();
  addSlot(s, COLORS);
  addSlot(s, COLORS);
  setSlotType(s, 1, 'closed');
  const markers = spawnMarkers(
    [
      [8, 8],
      [50, 8],
      [8, 50],
      [50, 50],
    ],
    64,
    64,
    s,
  );
  assert.deepEqual(
    markers.map((m) => [m.number, m.slot, m.color]),
    [
      [1, 0, 0],
      [3, 2, 2],
      [4, 3, 3],
      [null, null, null],
    ],
  );
  assert.equal(markers[0].left, ((8 + 1.5) / 64) * 100);
  assert.equal(markers[0].top, ((8 + 2) / 64) * 100);
});
