// Map handed to the game by the URL: `?editorTest=1` (test play from the map
// editor, map in sessionStorage) or `?map=<id>` (a published map from the API).
// Not wired into main.js here; the caller decides how to start the game.

import { parseMap } from '../editor/js/mapformat.js';
import { fetchMap } from '../editor/js/online.js';

/** sessionStorage key the editor writes before opening `/play/?editorTest=1`. */
export const TEST_MAP_KEY = 'webra.editor.testMap';

/**
 * The map the page was opened with, or null when the URL asks for none.
 *
 * Returns the parsed map object (format 1; pass `JSON.stringify(map)` to
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
