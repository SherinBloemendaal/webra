// Game modes: named bundles of lobby options (docs/contracts.md, section 3).
//
// A mode sets every option in PRESET_KEYS and nothing else: the seed, the map
// size (it follows the player count) and the players stay as they are. Modes
// are a lobby convenience only: the host still sends plain `options`, so
// nothing about them travels over the wire and the server validates the
// options as usual. Players can save their own modes in their settings
// document (`lobby.presets`, docs/accounts-api.md section 5.8), validated by
// validateSavedPresets on the client and the server alike.

import {
  BIOMES,
  BOOLEAN_OPTIONS,
  DEFAULT_OPTIONS,
  GAME_SPEEDS,
  MAP_STYLES,
  STARTING_CASH,
  STARTING_UNITS,
  TECH_BUILDINGS,
  TECH_LEVELS,
  TIME_LIMITS,
  WEATHER_MODES,
} from './constants.js';
import { bool, fail, isPlainObject, object, oneOf, ProtocolError, text } from './check.js';

/** The lobby options a mode sets: everything but the seed and the map size. */
export const PRESET_KEYS = Object.freeze([
  'mapStyle',
  'biome',
  'weather',
  'techBuildings',
  'startingCash',
  'startingUnits',
  'techLevel',
  'gameSpeed',
  'timeLimit',
  ...BOOLEAN_OPTIONS,
]);

/**
 * Keys added to the modes after players could save them (protocol 6:
 * OpenRA's crates, short game, kill bounties, separate team spawns, ally
 * build radius and time limit; reusable engineers). A saved mode without them takes the
 * defaults, so older settings documents stay valid.
 */
export const ADDED_PRESET_KEYS = Object.freeze([
  'timeLimit',
  'crates',
  'shortGame',
  'bounty',
  'separateTeamSpawns',
  'allyBuildRadius',
  'reusableEngineers',
  'techBuildings',
]);

/** Most saved modes per account. */
export const PRESETS_MAX = 16;
/** Longest name of a saved mode, in characters. */
export const PRESET_NAME_MAX = 32;

/** The mode bundle of a set of lobby options (only PRESET_KEYS, in that order). */
export function presetOptions(options) {
  return Object.fromEntries(PRESET_KEYS.map((k) => [k, options?.[k]]));
}

const base = presetOptions(DEFAULT_OPTIONS);
const mode = (id, name, description, overrides, extra = {}) =>
  Object.freeze({ id, name, description, options: Object.freeze({ ...base, ...overrides }), ...extra });

/**
 * Built-in modes, in menu order. `skirmishOnly` modes are not offered in
 * online lobbies.
 */
export const BUILTIN_MODES = Object.freeze([
  mode('classic', 'Classic', 'Red Alert as it was: temperate land, clear skies, normal speed.', {
    mapStyle: 'land',
    biome: 'temperate',
    weather: 'off',
  }),
  mode('weatherwar', 'Weather war', 'A random biome with its full weather: storms cut sight, snow makes vehicles slide, heat waves overheat them.', {
    mapStyle: 'random',
    biome: 'random',
    weather: 'full',
  }),
  mode('winter', 'Winter', 'Snow biome with full weather: snowfall, sliding vehicles, slower infantry and ice.', {
    biome: 'snow',
    weather: 'full',
  }),
  mode('desertstorm', 'Desert storm', 'Desert biome with full weather: heat waves overheat vehicles, sandstorms cut sight to 75 %.', {
    biome: 'desert',
    weather: 'full',
  }),
  mode('islands', 'Islands naval', 'A sea with islands and straits: every base has a harbour, so navies decide the game. Extra cash to build them.', {
    mapStyle: 'islands',
    startingCash: 10000,
  }),
  mode('rush', 'Rush', 'Little cash, light support, no superweapons, a fast clock and kill bounties: strike early.', {
    startingCash: 2500,
    startingUnits: 'light',
    techLevel: 'high',
    gameSpeed: 'fast',
    bounty: true,
  }),
  mode('turtle', 'Turtle', 'Lots of cash and a slower clock: build up a fortress before the fighting starts. Every last unit must go.', {
    startingCash: 20000,
    gameSpeed: 'slower',
    shortGame: false,
  }),
  mode(
    'competitive',
    'Competitive',
    'Fair and quick: no crates, no weather, short game and a 60 minute limit (the most experienced side wins).',
    { mapStyle: 'land', biome: 'temperate', weather: 'off', crates: false, shortGame: true, timeLimit: 60 },
  ),
  mode(
    'sandbox',
    'Sandbox',
    'The debug menu is on, with lots of cash and the map revealed: try things out against the AI.',
    { startingCash: 20000, explored: true, cheats: true },
    { skirmishOnly: true },
  ),
]);

/**
 * Strictly validate a mode bundle: exactly PRESET_KEYS, every value from its
 * value set. ADDED_PRESET_KEYS left out (modes saved before they existed)
 * take their defaults.
 */
export function validatePresetOptions(raw, what = 'options') {
  object(raw, PRESET_KEYS, what);
  const v = { ...raw };
  for (const k of ADDED_PRESET_KEYS) if (!(k in v)) v[k] = DEFAULT_OPTIONS[k];
  const out = {
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
  for (const k of BOOLEAN_OPTIONS) out[k] = bool(v[k], `${what}.${k}`);
  return out;
}

/** A saved mode name: display text rules (NFC, single spaces, no control characters). */
export function validPresetName(v, what = 'name') {
  return text(v, 1, PRESET_NAME_MAX, what);
}

/** Two names are the same mode when they match ignoring case. */
export const presetNameKey = (name) => String(name).toLocaleLowerCase('en-US');

/**
 * Strictly validate a list of saved modes `[{ name, options }]`: at most
 * PRESETS_MAX, names unique (ignoring case) and different from the built-in
 * modes' names. Returns a clean copy; throws a ProtocolError whose `path`
 * names the offending entry (`[2].options.biome`).
 */
export function validateSavedPresets(list, what = 'presets') {
  if (!Array.isArray(list)) fail(`${what} must be a list`);
  if (list.length > PRESETS_MAX) fail(`${what} must hold at most ${PRESETS_MAX} modes`);
  const builtin = new Set(BUILTIN_MODES.map((m) => presetNameKey(m.name)));
  const seen = new Set();
  return list.map((p, i) => {
    const w = `${what}[${i}]`;
    try {
      if (!isPlainObject(p)) fail(`${w} must be an object`);
      object(p, ['name', 'options'], w);
      const name = validPresetName(p.name, `${w}.name`);
      if (name !== p.name) fail(`${w}.name must not have extra spaces`);
      const key = presetNameKey(name);
      if (builtin.has(key)) fail(`${w}.name is the name of a built-in mode`);
      if (seen.has(key)) fail(`${w}.name is used twice`);
      seen.add(key);
      return { name, options: validatePresetOptions(p.options, `${w}.options`) };
    } catch (err) {
      if (err instanceof ProtocolError && err.path === undefined) {
        const m = /^([^\s:]+)/.exec(err.message);
        err.path = m && m[1].startsWith(w) ? m[1].slice(what.length) : `[${i}]`;
      }
      throw err;
    }
  });
}
