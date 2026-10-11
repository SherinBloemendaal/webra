// Map handed to the game by the URL: `?editorTest=1` (test play from the map
// editor, map in sessionStorage) or `?map=<id>` (a published map from the API).
// Not wired into main.js here; the caller decides how to start the game.

import { parseMap } from '../editor/js/mapformat.js';
import { fetchMap } from '../editor/js/online.js';

/** sessionStorage key the editor writes before opening `/play/?editorTest=1`. */
export const TEST_MAP_KEY = 'webra.editor.testMap';
/**
 * sessionStorage key of the editor's test play setup (next to the map):
 * `{ players: [{ type, faction, difficulty, bot, team }], camera: [x, y] |
 * null, autostart }`. The lobby takes the slots (checked like stored lobby
 * settings, js/lobby-state.js sanitizeState), the game starts the camera at
 * `camera` (world pixels) and, with `autostart`, the game starts at once.
 */
export const TEST_SETUP_KEY = 'webra.editor.testSetup';

/**
 * The editor's test play setup for `?editorTest=1`, or null (none, or
 * unreadable: the lobby then opens with the map as usual). Only the shape is
 * checked here; the lobby checks every value.
 */
export function loadTestSetup(params = new URLSearchParams(location.search), storage = globalThis.sessionStorage) {
  if (params.get('editorTest') !== '1') return null;
  let raw;
  try {
    raw = JSON.parse(storage?.getItem(TEST_SETUP_KEY) ?? 'null');
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.players) || raw.players.length < 2 || raw.players.length > 8) return null;
  const camera = Array.isArray(raw.camera) && raw.camera.length === 2 && raw.camera.every((v) => Number.isFinite(v)) ? [raw.camera[0], raw.camera[1]] : null;
  const players = raw.players.map((p) => (p && typeof p === 'object' ? { type: p.type, faction: p.faction, difficulty: p.difficulty, bot: p.bot, team: p.team } : {}));
  const movement = typeof raw.movement === 'string' ? raw.movement : null;
  return { players, movement, camera, autostart: raw.autostart === true };
}

/**
 * The map the page was opened with, or null when the URL asks for none.
 *
 * Returns the parsed map object (format 1 or 2; pass `JSON.stringify(map)` to
 * `Game.from_map` / `Game.validate_map`). Throws an Error with a message for
 * the player when a map was requested but cannot be loaded (missing test map,
 * bad JSON, map service unavailable, hash mismatch).
 *
 * @param {URLSearchParams} [params] defaults to the page's query string
 */
export async function loadPendingMap(params = new URLSearchParams(location.search)) {
  if (params.get('editorTest') === '1') {
    let text = null;
    try {
      text = sessionStorage.getItem(TEST_MAP_KEY);
    } catch {
      throw new Error('The test map cannot be read: browser storage is blocked.');
    }
    if (!text) throw new Error('No test map found. Start test play from the map editor.');
    return parseMap(text);
  }
  const id = params.get('map');
  if (id) {
    const { map } = await fetchMap(id);
    return map;
  }
  return null;
}
