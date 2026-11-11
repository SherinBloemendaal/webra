// Error reports from the map editor (js/telemetry, started by
// js/telemetry/boot.js before the editor loads): the editor follows the
// "Send error reports" setting like the game, and tells the reports'
// redactor the players' text it handles (protocol/scrub.js): the author name
// of new maps, the names and authors of the maps it opens, edits and lists.

import { connectRegistry, noteUserText } from '../../js/telemetry/index.js';

/** Follow the setting and note the author name of new maps. Returns a function that stops. */
export function connectEditorTelemetry(registry) {
  const off = connectRegistry(registry);
  noteUserText(registry.get('extra', 'editorAuthor'));
  return off;
}

/**
 * Note the name and author of maps (one map object, or a list such as the
 * published maps): cut out of every later report. Called when a map opens
 * and after a burst of edits (not per keystroke, so a half typed name does
 * not cut short words out of reports).
 */
export function noteMapText(maps) {
  for (const m of Array.isArray(maps) ? maps : [maps]) {
    if (m && typeof m === 'object') noteUserText({ name: m.name, author: m.author });
  }
}
