// OpenRA's other lobby options (src/constants.js, options.js, presets.js,
// spawns.js): crates, short game, kill bounties, separate team spawns, ally
// build radius, the time limit, per player handicaps and picked spawns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ADDED_PRESET_KEYS,
  BUILTIN_MODES,
  BOOLEAN_OPTIONS,
  DEFAULT_OPTIONS,
  HANDICAPS,
  PRESET_KEYS,
  TIME_LIMITS,
  assignSpawns,
  spawnLetter,
  battlefieldSpawns,
  generatedMapPlayers,
  spawnPickProblem,
  SPAWN_MAX,
  parseClientMessage,
  presetOptions,
  validateGameOptions,
  BOTS,
  validateLobbyOptions,
  validateSavedPresets,
  validLobbySlot,
} from '../src/index.js';

const players = [
  { slot: 0, type: 'human', name: 'Host', faction: 'germany', color: 0, team: 0 },
  { slot: 1, type: 'ai', difficulty: 'normal', faction: 'russia', color: 1, team: 0 },
];

test('the new options default to OpenRA and are strict', () => {
  for (const k of ['crates', 'shortGame', 'bounty', 'separateTeamSpawns', 'allyBuildRadius']) assert.ok(BOOLEAN_OPTIONS.includes(k), k);
  assert.deepEqual(
    [DEFAULT_OPTIONS.crates, DEFAULT_OPTIONS.shortGame, DEFAULT_OPTIONS.bounty, DEFAULT_OPTIONS.separateTeamSpawns, DEFAULT_OPTIONS.allyBuildRadius],
    [true, true, false, true, true],
  );
  assert.deepEqual(TIME_LIMITS, [0, 10, 20, 30, 40, 60, 90], 'world.yaml TimeLimitManager');
  assert.equal(DEFAULT_OPTIONS.timeLimit, 0);
  for (const t of TIME_LIMITS) assert.equal(validateLobbyOptions({ ...DEFAULT_OPTIONS, timeLimit: t }).timeLimit, t);
  assert.throws(() => validateLobbyOptions({ ...DEFAULT_OPTIONS, timeLimit: 15 }), /timeLimit/);
  assert.throws(() => validateLobbyOptions({ ...DEFAULT_OPTIONS, crates: 'on' }), /crates/);
  const { shortGame: _s, ...missing } = DEFAULT_OPTIONS;
  assert.throws(() => validateLobbyOptions(missing), /shortGame/);
});

test('bot types: AI players only, the Normal AI when left out', () => {
  assert.deepEqual(BOTS, ['rush', 'normal', 'turtle', 'naval']);
  const ai = players.findIndex((p) => p.type === 'ai');
  const human = players.findIndex((p) => p.type === 'human');
  const withBot = (i, bot) => players.map((p, k) => (k === i ? { ...p, bot } : p));
  assert.equal(validateGameOptions({ ...DEFAULT_OPTIONS, players: withBot(ai, 'turtle') }).players[ai].bot, 'turtle');
  assert.equal(validateGameOptions({ ...DEFAULT_OPTIONS, players }).players[ai].bot, undefined);
  assert.throws(() => validateGameOptions({ ...DEFAULT_OPTIONS, players: withBot(ai, 'hacky') }), /bot/);
  assert.throws(() => validateGameOptions({ ...DEFAULT_OPTIONS, players: withBot(human, 'rush') }), /bot/);
});

test('handicaps: 0 to 95 in steps of 5, per player, 0 when left out', () => {
  assert.equal(HANDICAPS.length, 20);
  assert.deepEqual([HANDICAPS[0], HANDICAPS[1], HANDICAPS.at(-1)], [0, 5, 95]);
  const opts = validateGameOptions({ ...DEFAULT_OPTIONS, players: [{ ...players[0], handicap: 35 }, players[1]] });
  assert.deepEqual(opts.players.map((p) => p.handicap ?? 0), [35, 0]);
  assert.throws(() => validateGameOptions({ ...DEFAULT_OPTIONS, players: [{ ...players[0], handicap: 33 }, players[1]] }), /handicap/);
  assert.throws(() => validateGameOptions({ ...DEFAULT_OPTIONS, players: [{ ...players[0], handicap: 100 }, players[1]] }), /handicap/);
  // The lobby: a player sets its own handicap, the host an AI's.
  const msg = parseClientMessage(JSON.stringify({ t: 'slot', slot: 1, handicap: 50 }));
  assert.equal(msg.ok, true);
  assert.equal(msg.msg.handicap, 50);
  assert.equal(parseClientMessage(JSON.stringify({ t: 'slot', slot: 1, handicap: 7 })).ok, false);
  const slot = { type: 'ai', difficulty: 'hard', faction: 'random', color: 2, team: 0 };
  assert.equal(validLobbySlot({ ...slot, handicap: 25 }).handicap, 25);
  assert.equal(validLobbySlot(slot).handicap ?? 0, 0);
  assert.throws(() => validLobbySlot({ ...slot, handicap: -5 }), /handicap/);
});

test('modes carry the new options; modes saved before them take the defaults', () => {
  for (const k of ['timeLimit', ...ADDED_PRESET_KEYS]) assert.ok(PRESET_KEYS.includes(k), k);
  const old = presetOptions(DEFAULT_OPTIONS);
  for (const k of ADDED_PRESET_KEYS) delete old[k];
  const [saved] = validateSavedPresets([{ name: 'From 0.8', options: { ...old, startingCash: 10000 } }]);
  assert.equal(saved.options.startingCash, 10000);
  for (const k of ADDED_PRESET_KEYS) assert.equal(saved.options[k], DEFAULT_OPTIONS[k], k);
  assert.throws(() => validateSavedPresets([{ name: 'Bad', options: { ...old, timeLimit: 5 } }]), /timeLimit/);
});

test('picked spawns: start options, slot messages and lobby slots carry them strictly', () => {
  // Start options: a picked spawn per player, at most once; left out is automatic.
  const opts = validateGameOptions({ ...DEFAULT_OPTIONS, players: [{ ...players[0], spawn: 3 }, players[1]] });
  assert.deepEqual(opts.players.map((p) => p.spawn), [3, undefined]);
  assert.throws(() => validateGameOptions({ ...DEFAULT_OPTIONS, players: [{ ...players[0], spawn: 1 }, { ...players[1], spawn: 1 }] }), /picked twice/);
  for (const bad of [-1, SPAWN_MAX + 1, 1.5, '1', null]) {
    assert.throws(() => validateGameOptions({ ...DEFAULT_OPTIONS, players: [{ ...players[0], spawn: bad }, players[1]] }), /spawn/, String(bad));
  }
  // The lobby: a slot picks a spawn, or goes back to automatic with null.
  assert.equal(parseClientMessage(JSON.stringify({ t: 'slot', slot: 0, spawn: 2 })).msg.spawn, 2);
  assert.equal(parseClientMessage(JSON.stringify({ t: 'slot', slot: 0, spawn: null })).msg.spawn, null);
  assert.equal(parseClientMessage(JSON.stringify({ t: 'slot', slot: 0, spawn: 8 })).ok, false);
  assert.equal(parseClientMessage(JSON.stringify({ t: 'slot', slot: 0, spawn: 'A' })).ok, false);
  const slot = { type: 'ai', difficulty: 'hard', faction: 'random', color: 2, team: 0 };
  assert.equal(validLobbySlot({ ...slot, spawn: 4 }).spawn, 4);
  assert.equal(validLobbySlot(slot).spawn, undefined, 'automatic');
  assert.throws(() => validLobbySlot({ ...slot, spawn: null }), /spawn/);
  assert.throws(() => validLobbySlot({ type: 'open', spawn: 1 }), /spawn/);
  // OpenRA names spawns A, B, C...; the lobby refuses picks the map cannot take.
  assert.deepEqual([0, 1, 7].map(spawnLetter), ['A', 'B', 'H']);
  assert.equal(spawnPickProblem([{ spawn: 1 }, {}], 2), null);
  assert.match(spawnPickProblem([{ spawn: 2 }, {}], 2), /picked start position C; this map has 2/);
  assert.match(spawnPickProblem([{ spawn: 0 }, { spawn: 0 }], 2), /Two players picked start position A/);
  // One count for both lobbies and the server: a generated map has a spawn per player, at least two.
  assert.deepEqual([0, 1, 2, 5].map(generatedMapPlayers), [2, 2, 2, 5]);
  assert.equal(battlefieldSpawns({ players: 1 }), 2, 'a host alone: the two player map');
  assert.equal(battlefieldSpawns({ players: 3 }), 3);
  assert.equal(battlefieldSpawns({ mapSpawns: 6, players: 2 }), 6, 'a map file: its own spawns');
  assert.equal(battlefieldSpawns({ mission: true, mapSpawns: 6, players: 2 }), 0, 'a mission places everyone');
});

test('spawn assignment matches the engine on the shared cases', () => {
  const { cases } = JSON.parse(readFileSync(new URL('./fixtures/spawn-cases.json', import.meta.url), 'utf8'));
  assert.ok(cases.length >= 5);
  for (const c of cases) {
    const players = c.teams.map((team, k) => ({ team, spawn: c.picks?.[k] ?? null }));
    assert.deepEqual(assignSpawns(c.spawns, players, c.separate, !!c.generated), c.want, JSON.stringify(c));
  }
});

test('the modes use the new options where their names promise it', () => {
  const by = Object.fromEntries(BUILTIN_MODES.map((m) => [m.id, m.options]));
  assert.equal(by.rush.bounty, true, 'rush: kill bounties');
  assert.equal(by.turtle.shortGame, false, 'turtle: every last unit must go');
  assert.deepEqual([by.competitive.crates, by.competitive.shortGame, by.competitive.timeLimit, by.competitive.weather], [false, true, 60, 'off']);
  assert.equal(by.classic.crates, true, 'classic Red Alert had crates');
});

test('the movement model: OpenRA by default, WebRA for games from before it, nothing else', async () => {
  const { MOVEMENT_MODELS, validateMissionOptions, MAP_OPTION_VALUES } = await import('../src/index.js');
  assert.deepEqual(MOVEMENT_MODELS, ['openra', 'webra']);
  assert.equal(DEFAULT_OPTIONS.movement, 'openra');
  for (const m of MOVEMENT_MODELS) assert.equal(validateLobbyOptions({ ...DEFAULT_OPTIONS, movement: m }).movement, m);
  assert.throws(() => validateLobbyOptions({ ...DEFAULT_OPTIONS, movement: 'push' }), /movement/);
  assert.throws(() => validateLobbyOptions({ ...DEFAULT_OPTIONS, movement: true }), /movement/);
  // Saves and replays from before the option keep it out: the engine plays them with `webra`.
  const { movement: _m, ...old } = DEFAULT_OPTIONS;
  assert.equal('movement' in validateLobbyOptions(old, 'options', { legacy: true }), false);
  assert.equal('movement' in validateGameOptions({ ...old, players }), false);
  // Live lobby options always carry it: a lobby never shows one model and plays another.
  assert.throws(() => validateLobbyOptions(old), /options\.movement/);
  assert.equal(parseClientMessage(JSON.stringify({ t: 'options', options: old })).ok, false);
  assert.equal(parseClientMessage(JSON.stringify({ t: 'options', options: DEFAULT_OPTIONS })).ok, true);
  assert.equal(validateGameOptions({ ...DEFAULT_OPTIONS, players }).movement, 'openra');
  // Missions: optional the same way.
  const mission = { seed: 3, gameSpeed: 'normal', options: { difficulty: 'hard' } };
  assert.equal('movement' in validateMissionOptions(mission), false);
  assert.equal(validateMissionOptions({ ...mission, movement: 'openra' }).movement, 'openra');
  assert.throws(() => validateMissionOptions({ ...mission, movement: 'soft' }), /movement/);
  // Game modes carry it; modes saved before it take OpenRA's.
  assert.ok(PRESET_KEYS.includes('movement') && ADDED_PRESET_KEYS.includes('movement'));
  const saved = presetOptions(DEFAULT_OPTIONS);
  delete saved.movement;
  assert.equal(validateSavedPresets([{ name: 'Before movement', options: saved }])[0].options.movement, 'openra');
  // A map may set and lock it (map format version 2).
  assert.deepEqual(MAP_OPTION_VALUES.movement, MOVEMENT_MODELS);
});

test('the factory loss rule: OpenRA by default, WebRA for games from before it, nothing else', async () => {
  const { FACTORY_LOSS_RULES, LEGACY_FACTORY_LOSS, validateMissionOptions, MAP_OPTION_VALUES, MISSION_OPTION_KEYS } = await import('../src/index.js');
  assert.deepEqual(FACTORY_LOSS_RULES, ['openra', 'webra']);
  assert.equal(DEFAULT_OPTIONS.factoryLoss, 'openra');
  assert.equal(LEGACY_FACTORY_LOSS, 'webra');
  for (const r of FACTORY_LOSS_RULES) assert.equal(validateLobbyOptions({ ...DEFAULT_OPTIONS, factoryLoss: r }).factoryLoss, r);
  assert.throws(() => validateLobbyOptions({ ...DEFAULT_OPTIONS, factoryLoss: 'refund' }), /factoryLoss/);
  assert.throws(() => validateLobbyOptions({ ...DEFAULT_OPTIONS, factoryLoss: false }), /factoryLoss/);
  // Saves and replays from before the option keep it out: the engine plays them with `webra`.
  const { factoryLoss: _f, ...old } = DEFAULT_OPTIONS;
  assert.equal('factoryLoss' in validateLobbyOptions(old, 'options', { legacy: true }), false);
  assert.equal('factoryLoss' in validateGameOptions({ ...old, players }), false);
  const { movement: _m, ...older } = old;
  assert.deepEqual(Object.keys(validateGameOptions({ ...older, players })).filter((k) => k === 'movement' || k === 'factoryLoss'), [], 'from before both');
  // Live lobby options always carry it.
  assert.throws(() => validateLobbyOptions(old), /options\.factoryLoss/);
  assert.equal(parseClientMessage(JSON.stringify({ t: 'options', options: old })).ok, false);
  assert.equal(validateGameOptions({ ...DEFAULT_OPTIONS, players }).factoryLoss, 'openra');
  // Missions: optional the same way.
  assert.ok(MISSION_OPTION_KEYS.includes('factoryLoss'));
  const mission = { seed: 3, gameSpeed: 'normal', options: { difficulty: 'hard' } };
  assert.equal('factoryLoss' in validateMissionOptions(mission), false);
  assert.equal(validateMissionOptions({ ...mission, factoryLoss: 'webra' }).factoryLoss, 'webra');
  assert.throws(() => validateMissionOptions({ ...mission, factoryLoss: 'wait' }), /factoryLoss/);
  // Game modes carry it; modes saved before it take OpenRA's.
  assert.ok(PRESET_KEYS.includes('factoryLoss') && ADDED_PRESET_KEYS.includes('factoryLoss'));
  const saved = presetOptions(DEFAULT_OPTIONS);
  delete saved.factoryLoss;
  assert.equal(validateSavedPresets([{ name: 'Before factory loss', options: saved }])[0].options.factoryLoss, 'openra');
  // A map may set and lock it.
  assert.deepEqual(MAP_OPTION_VALUES.factoryLoss, FACTORY_LOSS_RULES);
});
