// Opening map files of any format version in the editor (docs/contracts.md
// section 2, "Map versions"). Pure, no DOM: editor.js shows the result.
//
// An older file is upgraded like everywhere else (packages/protocol
// upgradeMap). A file that cannot be upgraded automatically (a removed or
// changed feature, or a newer format) is still opened, best effort
// (salvageMap): the editor loads what it can and lists each problem with its
// location and quick fixes, so the author can repair the map and save it in
// the current format.

import { applyMapFix, MAP_VERSIONS, salvageMap, upgradeMap } from '../../js/protocol.js';
import { decodeLayers, LIMITS } from './mapformat.js';

/** Whether MapDoc can load the map as it is (sizes and layers readable). */
function loadable(map) {
  const size = (v) => Number.isInteger(v) && v >= LIMITS.minSize && v <= LIMITS.maxSize;
  if (!size(map.width) || !size(map.height)) return false;
  try {
    decodeLayers(map);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the editor opens for a parsed map file:
 * `{ map, status, notice, notes, problems }`, or `{ map: null, error }` when
 * the file holds no map object at all. `status` is upgradeMap's; `notice` is
 * shown until the map is saved (the upgrade notice, or why the map is not
 * compatible); `problems` are upgradeMap's and salvageMap's, each
 * `{ message, x?, y?, fixes: [{ label, action }] }`.
 */
export function openMapFile(raw, versions = MAP_VERSIONS) {
  const up = upgradeMap(raw, versions);
  if ((up.status === 'current' || up.status === 'upgraded') && loadable(up.map)) {
    return { map: up.map, status: up.status, notice: up.message, notes: up.notes, problems: [] };
  }
  const salvaged = salvageMap(raw, { versions });
  if (!salvaged) return { map: null, status: 'invalid', error: 'The file does not contain a map object.' };
  const notice = salvaged.message ?? 'Parts of this map could not be read; the editor opened what it could. Check the problems below and save it again.';
  return { map: salvaged.map, status: salvaged.status, notice, notes: up.notes, problems: salvaged.problems };
}

/** Apply a quick fix of a listed problem to a map (doc.toMap()). Returns the changed map. */
export function applyFix(map, fix) {
  return applyMapFix(map, fix.action);
}
