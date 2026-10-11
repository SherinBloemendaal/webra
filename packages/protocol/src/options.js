// Game options (docs/contracts.md, section 3).
//
// Lobby options are what the host edits; game options are what the engine
// receives at start: lobby options plus the resolved player list.

import {
  BOOLEAN_OPTIONS,
  COLOR_COUNT,
  DIFFICULTIES,
  BOTS,
  FACTIONS,
  BIOMES,
  GAME_SPEEDS,
  MAP_SIZES,
  MAP_STYLES,
  MAX_PLAYERS,
  MIN_PLAYERS,
  NAME_MAX,
  NAME_MIN,
  PLAYABLE_FACTIONS,
  SEED_MAX,
  STARTING_CASH,
  STARTING_UNITS,
  TEAM_MAX,
  TECH_BUILDINGS,
  TECH_LEVELS,
  TIME_LIMITS,
  WEATHER_MODES,
  HANDICAPS,
  MOVEMENT_MODELS,
} from './constants.js';
import { bool, fail, int, isPlainObject, object, oneOf, text } from './check.js';

export const LOBBY_OPTION_KEYS = [
  'seed',
  'mapSize',
  'mapStyle',
  'biome',
  'weather',
  'techBuildings',
  'startingCash',
  'startingUnits',
  'techLevel',
  'gameSpeed',
  'timeLimit',
  'movement',
  ...BOOLEAN_OPTIONS,
];

/**
 * Strictly validate host-editable lobby options. Every key is required,
 * except `movement`: games saved or recorded before it existed lack it and
 * play with `webra` (the engine's default for an absent key).
 */
export function validateLobbyOptions(v, what = 'options') {
  object(v, LOBBY_OPTION_KEYS, what);
  const out = {
    seed: int(v.seed, 0, SEED_MAX, `${what}.seed`),
    mapSize: oneOf(v.mapSize, MAP_SIZES, `${what}.mapSize`),
    mapStyle: oneOf(v.mapStyle, MAP_STYLES, `${what}.mapStyle`),
    biome: oneOf(v.biome, BIOMES, `${what}.biome`),
    weather: oneOf(v.weather, WEATHER_MODES, `${what}.weather`),
    techBuildings: oneOf(v.techBuildings, TECH_BUILDINGS, `${what}.techBuildings`),
    startingCash: oneOf(v.startingCash, STARTING_CASH, `${what}.startingCash`),
    startingUnits: oneOf(v.startingUnits, STARTING_UNITS, `${what}.startingUnits`),
    techLevel: oneOf(v.techLevel, TECH_LEVELS, `${what}.techLevel`),
    gameSpeed: oneOf(v.gameSpeed, GAME_SPEEDS, `${what}.gameSpeed`),
    timeLimit: oneOf(v.timeLimit, TIME_LIMITS, `${what}.timeLimit`),
  };
  if (v.movement !== undefined) out.movement = oneOf(v.movement, MOVEMENT_MODELS, `${what}.movement`);
  for (const k of BOOLEAN_OPTIONS) out[k] = bool(v[k], `${what}.${k}`);
  return out;
}

const PLAYER_KEYS = ['slot', 'type', 'name', 'faction', 'color', 'team', 'difficulty', 'bot', 'handicap'];

/**
 * Validate the options the engine receives at game start: lobby options plus
 * `players`, with concrete (non-random) factions and unique colours.
 */
export function validateGameOptions(v, what = 'options') {
  if (!isPlainObject(v)) fail(`${what} must be an object`);
  const { players, ...rest } = v;
  const out = validateLobbyOptions(rest, what);
  if (!Array.isArray(players) || players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    fail(`${what}.players must list ${MIN_PLAYERS} to ${MAX_PLAYERS} players`);
  }
  const colors = new Set();
  out.players = players.map((p, i) => {
    const w = `${what}.players[${i}]`;
    object(p, PLAYER_KEYS, w);
    const player = {
      slot: int(p.slot, 0, MAX_PLAYERS - 1, `${w}.slot`),
      type: oneOf(p.type, ['human', 'ai'], `${w}.type`),
    };
    if (player.slot !== i) fail(`${w}.slot must equal its index`);
    if (player.type === 'human') {
      player.name = text(p.name, NAME_MIN, NAME_MAX, `${w}.name`);
      if (p.difficulty !== undefined) fail(`${w}: humans have no difficulty`);
      if (p.bot !== undefined) fail(`${w}: humans have no bot`);
    } else {
      if (p.name !== undefined) player.name = text(p.name, NAME_MIN, NAME_MAX, `${w}.name`);
      player.difficulty = oneOf(p.difficulty, DIFFICULTIES, `${w}.difficulty`);
      // Bot type: left out means the Normal AI, as in games before bot types.
      if (p.bot !== undefined) player.bot = oneOf(p.bot, BOTS, `${w}.bot`);
    }
    player.faction = oneOf(p.faction, PLAYABLE_FACTIONS, `${w}.faction`);
    player.color = int(p.color, 0, COLOR_COUNT - 1, `${w}.color`);
    if (colors.has(player.color)) fail(`${w}.color is used twice`);
    colors.add(player.color);
    player.team = int(p.team ?? 0, 0, TEAM_MAX, `${w}.team`);
    // Handicap: left out means 0 (the engine's default), as in games before it existed.
    if (p.handicap !== undefined) player.handicap = oneOf(p.handicap, HANDICAPS, `${w}.handicap`);
    return player;
  });
  return out;
}

/** Faction values a lobby slot may hold (including the random ones). */
export function validFaction(v, what) {
  return oneOf(v, FACTIONS, what);
}
