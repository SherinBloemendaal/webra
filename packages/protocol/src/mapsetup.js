// The game setup a map carries (map format version 2; docs/contracts.md
// section 2, "Map setup"): its player slots (OpenRA MapPlayers: faction,
// team, colour, an AI in the slot, and which of them the lobby may not
// change), the lobby options it starts with and the ones it locks, its tags,
// and the state of its pre-placed actors (health, stance, veterancy,
// passengers). Shared by the map checks (map.js), the lobbies (the game's
// skirmish lobby and the server's online rooms) and the map editor.

import {
  BOOLEAN_OPTIONS,
  BOTS,
  COLOR_COUNT,
  DIFFICULTIES,
  FACTIONS,
  GAME_SPEEDS,
  RANDOM_FACTIONS,
  STANCES,
  STARTING_CASH,
  STARTING_UNITS,
  TEAM_MAX,
  TECH_LEVELS,
  TIME_LIMITS,
  WEATHER_MODES,
} from './constants.js';
import { excerpt, fail, int, isPlainObject, object, oneOf } from './check.js';

/**
 * Lobby options a map may set and lock, with their values. Not the generator
 * options (seed, size, style, biome, tech buildings): a map file is its own
 * battlefield.
 */
export const MAP_OPTION_VALUES = Object.freeze({
  weather: WEATHER_MODES,
  startingCash: STARTING_CASH,
  startingUnits: STARTING_UNITS,
  techLevel: TECH_LEVELS,
  gameSpeed: GAME_SPEEDS,
  timeLimit: TIME_LIMITS,
  ...Object.fromEntries(BOOLEAN_OPTIONS.map((k) => [k, [true, false]])),
});
/** Keys of MAP_OPTION_VALUES, in the order the lobby lists them. */
export const MAP_OPTION_KEYS = Object.freeze(Object.keys(MAP_OPTION_VALUES));

/** What a slot holds when the map is loaded: open (a player or the lobby's choice), an AI, or closed. */
export const MAP_SLOT_TYPES = Object.freeze(['open', 'ai', 'closed']);
/** Parts of a slot a map can lock. */
export const MAP_SLOT_LOCKS = Object.freeze(['faction', 'team', 'color', 'type']);
/** A map slot with nothing set: the lobby decides everything (the canonical form fills these in). */
export const MAP_SLOT_DEFAULTS = Object.freeze({ faction: 'random', team: 0, color: -1, type: 'open', difficulty: 'normal', bot: 'normal', lock: Object.freeze([]) });
const SLOT_KEYS = Object.keys(MAP_SLOT_DEFAULTS);

/** Tags: at most this many, each 1 to MAP_TAG_MAX characters of lower-case letters, digits, spaces and hyphens. */
export const MAP_TAGS_MAX = 8;
export const MAP_TAG_MAX = 24;
const TAG_RE = /^[a-z0-9](?:[a-z0-9 -]*[a-z0-9])?$/;

/** Pre-placed actor state: health in percent, a fire stance, a veterancy level, passengers. */
export const ACTOR_HEALTH_MIN = 1;
export const ACTOR_HEALTH_MAX = 100;
export const ACTOR_VETERANCY_MAX = 4;
export const ACTOR_CARGO_MAX = 16;
export const ACTOR_STANCES = STANCES;

/** Validate a map's slots (`players`; at most `spawns` of them). Returns them with defaults filled in. */
export function validateMapPlayers(v, spawns) {
  if (!Array.isArray(v)) fail('players must be a list');
  if (v.length > spawns) fail(`players lists ${v.length} slots; the map has ${spawns} spawns`);
  const out = v.map((p, i) => {
    const w = `players[${i}]`;
    object(p, SLOT_KEYS, w);
    const slot = {
      faction: oneOf(p.faction ?? MAP_SLOT_DEFAULTS.faction, FACTIONS, `${w}.faction`),
      team: int(p.team ?? 0, 0, TEAM_MAX, `${w}.team`),
      color: int(p.color ?? -1, -1, COLOR_COUNT - 1, `${w}.color`),
      type: oneOf(p.type ?? 'open', MAP_SLOT_TYPES, `${w}.type`),
      difficulty: oneOf(p.difficulty ?? 'normal', DIFFICULTIES, `${w}.difficulty`),
      bot: oneOf(p.bot ?? 'normal', BOTS, `${w}.bot`),
      lock: p.lock ?? [],
    };
    if (!Array.isArray(slot.lock) || slot.lock.length > MAP_SLOT_LOCKS.length) fail(`${w}.lock must list some of ${MAP_SLOT_LOCKS.join(', ')}`);
    slot.lock.forEach((l, k) => {
      oneOf(l, MAP_SLOT_LOCKS, `${w}.lock[${k}]`);
      if (slot.lock.indexOf(l) !== k) fail(`${w}.lock lists ${l} twice`);
    });
    slot.lock = [...slot.lock];
    if (slot.lock.includes('color') && slot.color < 0) fail(`${w}: a locked colour needs a colour`);
    return slot;
  });
  const colors = out.filter((s) => s.color >= 0).map((s) => s.color);
  if (new Set(colors).size !== colors.length) fail('players: two slots have the same colour');
  // At least two slots stay playable (spawns without an entry are open).
  const closed = out.filter((s) => s.type === 'closed' && s.lock.includes('type')).length;
  if (spawns - closed < 2) fail('players: a map must leave at least two slots that can play');
  return out;
}

/** Validate the options a map starts with. Returns a copy. */
export function validateMapOptions(v) {
  if (!isPlainObject(v)) fail('options must be an object');
  const out = {};
  for (const k of Object.keys(v)) {
    if (!Object.hasOwn(MAP_OPTION_VALUES, k)) fail(`options: ${excerpt(k)} is not an option a map can set`);
    if (!MAP_OPTION_VALUES[k].includes(v[k])) fail(`options.${k} must be one of ${MAP_OPTION_VALUES[k].join(', ')}`);
    out[k] = v[k];
  }
  return out;
}

/** Validate the options a map locks: each one it sets, once. */
export function validateLockedOptions(v, options) {
  if (!Array.isArray(v)) fail('lockedOptions must be a list');
  v.forEach((k, i) => {
    if (typeof k !== 'string' || !Object.hasOwn(options ?? {}, k)) fail(`lockedOptions[${i}] must name an option the map sets in options`);
    if (v.indexOf(k) !== i) fail(`lockedOptions lists ${excerpt(k)} twice`);
  });
  return [...v];
}

/** Validate tags. */
export function validateTags(v) {
  if (!Array.isArray(v) || v.length > MAP_TAGS_MAX) fail(`tags must be a list of at most ${MAP_TAGS_MAX}`);
  v.forEach((t, i) => {
    if (typeof t !== 'string' || t.length > MAP_TAG_MAX || !TAG_RE.test(t)) fail(`tags[${i}] must be 1 to ${MAP_TAG_MAX} lower-case letters, digits, spaces or hyphens`);
    if (v.indexOf(t) !== i) fail(`tags lists ${t} twice`);
  });
  return [...v];
}

/**
 * Validate the state fields of a pre-placed actor (`a`, the file's object;
 * `w` names it). Shape only: whether the actor type can have a stance,
 * levels or passengers is the engine's check (it knows the rules).
 */
export function validateActorState(a, w) {
  const out = {};
  if (a.health !== undefined) out.health = int(a.health, ACTOR_HEALTH_MIN, ACTOR_HEALTH_MAX, `${w} health`);
  if (a.stance !== undefined) out.stance = oneOf(a.stance, ACTOR_STANCES, `${w} stance`);
  if (a.veterancy !== undefined) out.veterancy = int(a.veterancy, 0, ACTOR_VETERANCY_MAX, `${w} veterancy`);
  if (a.cargo !== undefined) {
    if (!Array.isArray(a.cargo) || a.cargo.length > ACTOR_CARGO_MAX) fail(`${w} cargo must list at most ${ACTOR_CARGO_MAX} passengers`);
    a.cargo.forEach((c, k) => {
      if (typeof c !== 'string' || !/^[A-Za-z0-9.]{1,16}$/.test(c)) fail(`${w} cargo[${k}] has an invalid type`);
    });
    out.cargo = [...a.cargo];
  }
  return out;
}

/**
 * The state fields of an actor in the canonical form: each only when not
 * its default (full health, the actor's own stance, no levels, no passengers).
 */
export function canonicalActorState(a) {
  return {
    ...(a.health !== undefined && a.health !== ACTOR_HEALTH_MAX ? { health: a.health } : {}),
    ...(a.stance !== undefined && a.stance !== null ? { stance: a.stance } : {}),
    ...(a.veterancy ? { veterancy: a.veterancy } : {}),
    ...(Array.isArray(a.cargo) && a.cargo.length ? { cargo: [...a.cargo] } : {}),
  };
}

/** A slot with its defaults filled in, keys in canonical order. */
export function canonicalSlot(p) {
  return {
    faction: p.faction ?? MAP_SLOT_DEFAULTS.faction,
    team: p.team ?? 0,
    color: p.color ?? -1,
    type: p.type ?? 'open',
    difficulty: p.difficulty ?? 'normal',
    bot: p.bot ?? 'normal',
    lock: [...(p.lock ?? [])],
  };
}

// ---- Lobbies --------------------------------------------------------------------------

/** Slot `k` of a map (validated or canonical): its entry, or the defaults for a spawn without one. */
export function mapSlot(map, k) {
  return canonicalSlot(map?.players?.[k] ?? {});
}

/** Whether `lock` (faction, team, color, type) of slot `k` is locked by the map. */
export function slotLocked(map, k, lock) {
  return mapSlot(map, k).lock.includes(lock);
}

/** Whether option `key` is locked by the map. */
export function optionLocked(map, key) {
  return Array.isArray(map?.lockedOptions) && map.lockedOptions.includes(key);
}

/**
 * Lobby options with the map's applied: every option the map sets replaces
 * the lobby's (a starting point the host may change unless it is locked).
 * `options` is the lobby's option object; returns a new one.
 */
export function applyMapOptions(options, map) {
  return { ...options, ...(isPlainObject(map?.options) ? map.options : {}) };
}

/**
 * Why lobby options break the map's locks, or null: each locked option must
 * have the map's value.
 */
export function lockedOptionProblem(options, map) {
  for (const k of map?.lockedOptions ?? []) {
    if (options?.[k] !== map.options?.[k]) return `This map locks ${k} to ${JSON.stringify(map.options[k])}.`;
  }
  return null;
}

/**
 * Why a lobby slot (`{ type, faction, team, color }`, type 'human', 'ai',
 * 'open' or 'closed') breaks slot `k`'s locks, or null. A locked faction
 * also allows the countries its random choice picks from (the slot may have
 * been resolved already); a locked type means open slots take a player
 * (human or AI as the lobby likes), AI slots an AI and closed slots stay closed.
 */
export function lockedSlotProblem(slot, map, k) {
  const m = mapSlot(map, k);
  const n = k + 1;
  if (m.lock.includes('type')) {
    const want = m.type;
    const kind = slot.type === 'human' || slot.type === 'ai' ? (slot.type === 'ai' ? 'ai' : 'human') : slot.type;
    if (want === 'closed' && kind !== 'closed') return `This map keeps slot ${n} closed.`;
    if (want === 'ai' && kind !== 'ai') return `This map gives slot ${n} to an AI.`;
    if (want === 'open' && kind === 'closed') return `This map keeps slot ${n} open for a player.`;
  }
  if (slot.type === 'closed' || slot.type === 'open') return null;
  if (m.lock.includes('faction') && slot.faction !== m.faction && !(RANDOM_FACTIONS[m.faction] ?? []).includes(slot.faction)) {
    return `This map locks the faction of slot ${n} (${m.faction}).`;
  }
  if (m.lock.includes('team') && (slot.team ?? 0) !== m.team) return `This map locks slot ${n} to ${m.team ? `team ${m.team}` : 'no team'}.`;
  if (m.lock.includes('color') && slot.color !== m.color) return `This map locks the colour of slot ${n}.`;
  return null;
}
