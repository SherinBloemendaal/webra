// Restart: play the current single player game again from tick 0 with
// exactly the same settings (options, generated map seed and parameters or
// the map file, players, AIs, factions, colours, teams).
//
// A game sets up audio, notifications, the minimap, the sidebar, input and
// the simulation worker once per page, so a restart reloads the page: the
// settings go to sessionStorage (this tab only) first, and the next boot
// takes them (once) and starts the game again, so every part of the screen
// starts fresh. The replay viewer restarts in place (playback from 0).
// Online games have a rematch instead: every player must agree, so the host
// proposes it and the session goes back to its lobby (js/online.js).
//
// Campaign missions go the same way: a mission record restarts a mission (or
// starts the next one) with its options, and a campaign record brings the
// campaign screen back after leaving a mission (js/campaign).

import { GAME_SPEEDS } from '../protocol/constants.js';

export const RESTART_KEY = 'webra.restart.v1';

const MISSION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OPTION = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The record for a skirmish started from lobby `options` (with `options.map`,
 * the map file text, or none for a generated map). Throws on anything that is
 * not a game's options.
 */
export function restartRecord(options) {
  if (!isObject(options) || !Array.isArray(options.players) || options.players.length === 0) throw new Error('not game options');
  if (options.map !== undefined && options.map !== null && typeof options.map !== 'string') throw new Error('map must be text');
  return { v: 1, kind: 'skirmish', options: structuredClone(options) };
}

/**
 * The record that starts mission `id` with its lobby options (`{ difficulty: 'hard' }`)
 * at `gameSpeed` (protocol GAME_SPEEDS). Throws on anything else.
 */
export function missionRecord(id, options = {}, gameSpeed = 'normal') {
  if (typeof id !== 'string' || !MISSION_ID.test(id)) throw new Error('not a mission id');
  if (!isObject(options)) throw new Error('mission options must be an object');
  const clean = {};
  for (const [k, v] of Object.entries(options)) {
    if (!OPTION.test(k) || typeof v !== 'string' || !OPTION.test(v)) throw new Error('bad mission option');
    clean[k] = v;
  }
  if (!GAME_SPEEDS.includes(gameSpeed)) throw new Error('bad game speed');
  return { v: 1, kind: 'mission', id, options: clean, gameSpeed };
}

/** The record that opens the campaign screen (at mission `id` when given). */
export function campaignRecord(id = null) {
  if (id !== null && (typeof id !== 'string' || !MISSION_ID.test(id))) throw new Error('not a mission id');
  return { v: 1, kind: 'campaign', id };
}

/** Store `record` for the next boot of this tab. Returns false when the browser refused (private mode, quota). */
export function saveRestart(record, storage) {
  try {
    storage.setItem(RESTART_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** The stored record, removed so it runs once; null when there is none or it is malformed. */
export function takeRestart(storage) {
  let text = null;
  try {
    text = storage?.getItem(RESTART_KEY) ?? null;
    if (text !== null) storage.removeItem(RESTART_KEY);
  } catch {
    return null;
  }
  if (text === null) return null;
  try {
    const r = JSON.parse(text);
    if (!isObject(r) || r.v !== 1) return null;
    if (r.kind === 'mission') return missionRecord(r.id, r.options, r.gameSpeed);
    if (r.kind === 'campaign') return campaignRecord(r.id ?? null);
    if (r.kind !== 'skirmish') return null;
    return restartRecord(r.options);
  } catch {
    return null;
  }
}
