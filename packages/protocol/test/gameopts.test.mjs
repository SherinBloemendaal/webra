// OpenRA's other lobby options (src/constants.js, options.js, presets.js,
// spawns.js): crates, short game, kill bounties, separate team spawns, ally
// build radius, the time limit and per player handicaps.
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

test('spawn assignment matches the engine on the shared cases', () => {
  const { cases } = JSON.parse(readFileSync(new URL('./fixtures/spawn-cases.json', import.meta.url), 'utf8'));
  assert.ok(cases.length >= 5);
  for (const c of cases) {
    assert.deepEqual(assignSpawns(c.spawns, c.teams.map((team) => ({ team })), c.separate, !!c.generated), c.want, JSON.stringify(c));
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
  assert.equal('movement' in validateLobbyOptions(old), false);
  assert.equal('movement' in validateGameOptions({ ...old, players }), false);
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
